import { Api, apiWebRTCProbe } from "../../api"
import { Logger } from "../log"

/// How long the probe may take before the network counts as unable to connect directly.
export const WEBRTC_PROBE_TIMEOUT_MS = 12_000

/// Waits for ICE gathering so the offer carries every candidate (the probe endpoint takes no
/// trickled candidates). STUN normally answers in well under a second.
const GATHER_TIMEOUT_MS = 3_000

export type ProbeResult =
    /// local: the PC is on this network (Lightning fork: caps the automatic bitrate), null = unknown
    | { connected: true, localType: string | null, remoteType: string | null, local: boolean | null }
    | { connected: false, reason: string }

/// Opens a data-channel-only connection to the host with the same ICE servers as the stream.
/// The host never starts streaming for it, so a network that cannot connect directly is found
/// out without waking Sunshine.
export async function probeDirectConnection(
    api: Api,
    configuration: RTCConfiguration,
    logger?: Logger,
    timeoutMs: number = WEBRTC_PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
    const peer = new RTCPeerConnection(configuration)

    try {
        peer.createDataChannel("probe")

        await peer.setLocalDescription(await peer.createOffer())
        await waitForGathering(peer)

        const offerSdp = peer.localDescription?.sdp
        if (!offerSdp) {
            return { connected: false, reason: "no local description" }
        }

        const answerSdp = await apiWebRTCProbe(api, offerSdp)
        await peer.setRemoteDescription({ type: "answer", sdp: answerSdp })

        const connected = await waitForConnection(peer, timeoutMs)
        if (!connected) {
            return { connected: false, reason: `connection ${peer.connectionState}, ice ${peer.iceConnectionState}` }
        }

        const [localType, remoteType, local] = await selectedCandidateTypes(peer)
        logger?.debug(`connection probe connected (local ${localType}, remote ${remoteType}, ${local == null ? "network unknown" : local ? "same network" : "over the internet"})`)

        return { connected: true, localType, remoteType, local }
    } catch (error) {
        return { connected: false, reason: `${error}` }
    } finally {
        peer.close()
    }
}

/// Lightning fork: also used by the main stream (webrtc.ts), see there
export function waitForGathering(peer: RTCPeerConnection): Promise<void> {
    if (peer.iceGatheringState == "complete") {
        return Promise.resolve()
    }

    return new Promise(resolve => {
        const done = () => {
            peer.removeEventListener("icegatheringstatechange", onChange)
            clearTimeout(timer)
            resolve()
        }
        const onChange = () => {
            if (peer.iceGatheringState == "complete") {
                done()
            }
        }
        const timer = setTimeout(done, GATHER_TIMEOUT_MS)

        peer.addEventListener("icegatheringstatechange", onChange)
    })
}

/// Waits for the full connection (ICE + DTLS), not just ICE: closing on ICE alone leaves the
/// host's peer short of "connected", so it would log the probe as a failure.
function waitForConnection(peer: RTCPeerConnection, timeoutMs: number): Promise<boolean> {
    return new Promise(resolve => {
        const finish = (value: boolean) => {
            peer.removeEventListener("connectionstatechange", onChange)
            clearTimeout(timer)
            resolve(value)
        }
        const onChange = () => {
            const state = peer.connectionState
            if (state == "connected") {
                finish(true)
            } else if (state == "failed" || state == "closed") {
                finish(false)
            }
        }
        const timer = setTimeout(() => finish(false), timeoutMs)

        peer.addEventListener("connectionstatechange", onChange)
        onChange()
    })
}

/// Candidate types of the selected pair (host / srflx / prflx / relay), for diagnostics.
/// Private (LAN) addresses: IPv4 private ranges, link-local, IPv6 unique-local and link-local
const PRIVATE_ADDRESS = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|f[cd][0-9a-f]{2}:|fe80:)/i
/// Below this round trip the PC is on the same network even with public addresses (IPv6 at home)
const LOCAL_RTT_SECONDS = 0.012

async function selectedCandidateTypes(peer: RTCPeerConnection): Promise<[string | null, string | null, boolean | null]> {
    try {
        const stats = await peer.getStats()

        let pair: any = null
        stats.forEach(report => {
            if (report.type == "transport" && report.selectedCandidatePairId) {
                pair = stats.get(report.selectedCandidatePairId)
            }
        })
        if (!pair) {
            stats.forEach(report => {
                if (report.type == "candidate-pair" && report.nominated && report.state == "succeeded") {
                    pair = report
                }
            })
        }
        if (!pair) {
            return [null, null, null]
        }

        const remote = stats.get(pair.remoteCandidateId)
        const address: string = remote?.address ?? remote?.ip ?? ""
        const rtt: number | undefined = pair.currentRoundTripTime
        let local: boolean | null = null
        if (address && PRIVATE_ADDRESS.test(address)) {
            local = true
        } else if (rtt != null) {
            local = rtt < LOCAL_RTT_SECONDS
        } else if (address) {
            local = false
        }

        return [
            stats.get(pair.localCandidateId)?.candidateType ?? null,
            remote?.candidateType ?? null,
            local,
        ]
    } catch {
        return [null, null, null]
    }
}
