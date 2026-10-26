import { globalObject } from "../util"
import { Logger } from "./log"
import { Pipe } from "./pipeline/index"
import { Transport } from "./transport/index"

export type StatValue = string | number

export type StreamStatsData = {
    videoPipeline: string | null
    audioPipeline: string | null
    transport: Record<string, StatValue>
    video: Record<string, StatValue>
    audio: Record<string, StatValue>
}

function num(value: number | null | undefined, suffix?: string): string | null {
    if (value == null) {
        return null
    } else {
        return `${value.toFixed(2)}${suffix ?? ""}`
    }
}

/// Lightning fork: one readable line of where the time goes, and a hint about the bottleneck.
/// Rates (loss, bitrate, key frames) come from the transport; anything missing is left out.
export type LatencyHints = {
    loss: string
    rtt: string
    buffer: string
    decode: string
    fps: string
}
export function latencySummary(transport: Record<string, StatValue>, requestedFps: number, bitrate: { kbps: number, auto: boolean } | null, hints: LatencyHints, tenBit = false): string {
    const n = (key: string) => typeof transport[key] == "number" && isFinite(transport[key] as number) ? transport[key] as number : null
    const rtt = n("rttMs"), buffer = n("jitterBufferMs"), decode = n("decodeTimePerFrameMs")
    const fps = n("currentFps"), loss = n("lossPercent"), mbps = n("receivedMbps"), idr = n("keyFramesPerMinute")

    const parts: Array<string> = []
    if (rtt != null) parts.push(`RTT ${rtt.toFixed(0)} ms`)
    if (buffer != null) parts.push(`buffer ${buffer.toFixed(0)} ms`)
    if (decode != null) parts.push(`decode ${decode.toFixed(1)} ms`)
    if (fps != null) parts.push(`${fps.toFixed(0)}/${requestedFps} fps`)
    if (loss != null) parts.push(`loss ${loss.toFixed(1)}%`)
    if (idr != null) parts.push(`IDR ${idr.toFixed(0)}/min`)
    if (mbps != null) parts.push(`${mbps.toFixed(1)}${bitrate ? `/${(bitrate.kbps / 1000).toFixed(1)}` : ""} Mbps${bitrate?.auto ? " auto" : ""}`)
    if (typeof transport.codec == "string") parts.push(transport.codec + (tenBit ? " 10-bit" : ""))

    // The first problem found, in the order that hurts the most
    let hint = ""
    if (loss != null && loss > 1) hint = hints.loss
    else if (rtt != null && rtt > 40) hint = hints.rtt
    else if (buffer != null && buffer > 40) hint = hints.buffer
    else if (decode != null && decode > 1000 / Math.max(requestedFps, 1)) hint = hints.decode
    else if (fps != null && fps < requestedFps * 0.85) hint = hints.fps

    return parts.join(" · ") + (hint ? `\n⚠ ${hint}` : "")
}

export function streamStatsToText(statsData: StreamStatsData): string {
    let text = `stats:
video pipeline: ${statsData.videoPipeline}
audio pipeline: ${statsData.audioPipeline}
`
    for (const key in statsData.transport) {
        const value = statsData.transport[key]
        let valuePretty = value

        if (typeof value == "number" && key.endsWith("Ms")) {
            valuePretty = `${num(value, "ms")}`
        }

        text += `${key}: ${valuePretty}\n`
    }

    for (const key in statsData.video) {
        const value = statsData.video[key]
        let valuePretty = value

        if (typeof value == "number" && key.endsWith("Ms")) {
            valuePretty = `${num(value, "ms")}`
        }

        text += `${key}: ${valuePretty}\n`
    }

    for (const key in statsData.audio) {
        const value = statsData.audio[key]
        let valuePretty = value

        if (typeof value == "number" && key.endsWith("Ms")) {
            valuePretty = `${num(value, "ms")}`
        }

        text += `${key}: ${valuePretty}\n`
    }

    return text
}

export class StreamStats {

    private logger: Logger | null = null

    private enabled: boolean = false
    private transport: Transport | null = null
    private updateIntervalId: number | null = null

    private videoPipe: Pipe | null = null
    private audioPipe: Pipe | null = null
    private statsData: StreamStatsData = {
        videoPipeline: null,
        audioPipeline: null,
        transport: {},
        video: {},
        audio: {}
    }

    constructor(logger?: Logger) {
        if (logger) {
            this.logger = logger
        }
    }

    setTransport(transport: Transport) {
        this.transport = transport
    }
    setEnabled(enabled: boolean) {
        this.enabled = enabled

        this.checkEnabled()
    }
    isEnabled(): boolean {
        return this.enabled
    }
    toggle() {
        this.setEnabled(!this.isEnabled())
    }

    private checkEnabled() {
        if (this.enabled && this.updateIntervalId == null) {
            this.updateIntervalId = globalObject().setInterval(this.updateLocalStats.bind(this), 100)
        } else if (!this.enabled && this.updateIntervalId != null) {
            globalObject().clearInterval(this.updateIntervalId)
            this.updateIntervalId = null
        }
    }

    private async updateLocalStats() {
        Promise.all([
            this.updateTransportStats(),
            this.updateVideoStats(),
            this.updateAudioStats(),
        ])
    }
    private async updateTransportStats() {
        if (!this.transport) {
            console.debug("Cannot query stats without transport")
            return
        }

        const stats = await this.transport?.getStats()
        for (const key in stats) {
            const value = stats[key]

            this.statsData.transport[key] = value
        }
    }
    private async updateVideoStats() {
        const stats = {}

        if (this.videoPipe && this.videoPipe.reportStats) {
            this.videoPipe.reportStats(stats)
        }

        this.statsData.video = stats
    }
    private async updateAudioStats() {
        const stats = {}

        if (this.audioPipe && this.audioPipe.reportStats) {
            this.audioPipe.reportStats(stats)
        }

        this.statsData.audio = stats
    }

    setVideoPipeline(name: string, pipe: Pipe | null) {
        this.statsData.videoPipeline = name
        this.videoPipe = pipe
    }
    setAudioPipeline(name: string, pipe: Pipe | null) {
        this.statsData.audioPipeline = name
        this.audioPipe = pipe
    }

    getCurrentStats(): StreamStatsData {
        const data = {}
        Object.assign(data, this.statsData)
        return data as StreamStatsData
    }
}
