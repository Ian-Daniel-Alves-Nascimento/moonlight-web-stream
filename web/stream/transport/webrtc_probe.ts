import { Api, apiWebRTCProbe } from "../../api"
import { Logger } from "../log"

/// How long the probe may take before the network counts as unable to connect directly.
export const WEBRTC_PROBE_TIMEOUT_MS = 12_000

/// Waits for ICE gathering so the offer carries every candidate (the probe endpoint takes no
/// trickled candidates). STUN normally answers in well under a second.
const GATHER_TIMEOUT_MS = 3_000

export type ProbeResult =
    | { connected: true, localType: string | null, remoteType: string | null }
    | { connected: false, reason: string }

/// Opens a data-channel-only connection to the host with the same ICE servers as the stream.
/// The host never starts streaming for it, so a network that cannot connect directly is found
/// out without waking Sunshine.
export async function probeDirectConnection(
    api: Api,
    configuration: RTCConfiguration,
    logger?: Logger,
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

        const connected = await waitForConnection(peer, WEBRTC_PROBE_TIMEOUT_MS)
        if (!connected) {
            return { connected: false, reason: `connection ${peer.connectionState}, ice ${peer.iceConnectionState}` }
        }

        const [localType, remoteType] = await selectedCandidateTypes(peer)
        logger?.debug(`connection probe connected (local ${localType}, remote ${remoteType})`)

        return { connected: true, localType, remoteType }
    } catch (error) {
        return { connected: false, reason: `${error}` }
    } finally {
        peer.close()
    }
}

function waitForGathering(peer: RTCPeerConnection): Promise<void> {
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
async function selectedCandidateTypes(peer: RTCPeerConnection): Promise<[string | null, string | null]> {
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
            return [null, null]
        }

        return [
            stats.get(pair.localCandidateId)?.candidateType ?? null,
            stats.get(pair.remoteCandidateId)?.candidateType ?? null,
        ]
    } catch {
        return [null, null]
    }
}
