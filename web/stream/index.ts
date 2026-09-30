import { Api, apiGetHostDisplay, apiWebRTCConfiguration, apiWebRTCOffer, FetchError } from "../api"
import { Component } from "../component/index"
import { Settings, TransportType, UpscalingAlgorithm } from "../component/settings_menu"
import { ControlPacket, ControlPacket_Tags, VideoFormats } from "../uniffi/moonlight_common_bindings"
import { wait } from "../util"
import { AudioPlayer, AudioPlayerSetup } from "./audio/index"
import { buildAudioPipeline } from "./audio/pipeline"
import { defaultStreamInputConfig, StreamInput } from "./input"
import { Logger, LogMessageInfo } from "./log"
import { gatherPipeInfo, pipeName } from "./pipeline/index"
import { StreamStats } from "./stats"
import { Transport, TransportAudioType, TransportConnectData, TransportOptions, TransportShutdown, TransportVideoType } from "./transport/index"
import { WebSocketTransport } from "./transport/web_socket"
import { WebRTCTransport } from "./transport/webrtc"
import { probeDirectConnection } from "./transport/webrtc_probe"
import { deviceStreamerSize, evenFloor, physicalScreenSize, safeAreaScreenSize, UpscalingDecision, upscalingStreamerSize } from "./upscaling"
import { autoVideoCodecs, codecFamily, CodecFamily } from "./codec"
import { allVideoCodecs, andVideoCodecs, emptyVideoCodecs, hasAnyCodec } from "./video"
import { VideoRenderer, VideoRendererSetup } from "./video/index"
import { VideoElementRenderer } from "./video/video_element"
import { UpscalerStats } from "./video/upscale"
import { buildVideoPipeline, queryVideoPipelineInfo, VideoPipelineOptions } from "./video/pipeline"
import { GetHostDisplayResponse, StreamPermissions } from "../api_bindings"

export type ExecutionEnvironment = {
    main: boolean
    worker: boolean
}

export type StreamCapabilities = {
    touch: boolean
}

export type InfoEvent = CustomEvent<
    { type: "app", appName: string } |
    { type: "connectionComplete", capabilities: StreamCapabilities } |
    { type: "videoReady" } |
    { type: "addDebugLine", line: string, additional?: LogMessageInfo } |
    // Lightning fork: plain progress and failure reasons for the connect screen
    { type: "stage", stage: StreamStage } |
    { type: "failure", reason: StreamFailure }
>
export type InfoEventListener = (event: InfoEvent) => void

/// Lightning fork: "network" = reaching the PC, "starting" = the PC is launching the app,
/// "video" = connected, building the video/audio pipelines.
export type StreamStage = "network" | "starting" | "video"
/// Lightning fork: why the stream couldn't start (or stopped), in terms a player can act on.
export type StreamFailure = "noDirectPath" | "codec" | "host" | "timeout" | "noVideo" | "ended" | "generic"

/// The host answers an offer it has no common video codec with using a bare 400.
function isCodecError(error: unknown): boolean {
    return error instanceof FetchError && error.getResponse()?.status == 400
}

export function getStreamerSize(settings: Settings, viewerScreenSize: [number, number]): [number, number] {
    let width, height
    if (settings.videoSize == "720p") {
        width = 1280
        height = 720
    } else if (settings.videoSize == "1080p") {
        width = 1920
        height = 1080
    } else if (settings.videoSize == "1440p") {
        width = 2560
        height = 1440
    } else if (settings.videoSize == "4k") {
        width = 3840
        height = 2160
    } else if (settings.videoSize == "custom") {
        width = settings.videoSizeCustom.width
        height = settings.videoSizeCustom.height
    } else if (settings.videoSize == "safe") {
        [width, height] = safeAreaScreenSize()
    } else {
        // Lightning fork: "auto" (refined once the host display is known), "full" and the old
        // "native" use this screen's physical pixels, not CSS pixels (852×393 on an iPhone 15 Pro)
        [width, height] = physicalScreenSize()
    }
    // Lightning fork: encoders (NVENC) refuse odd sizes and the stream then has no video
    // (the iPhone 15 Pro screen is 2556×1179)
    return [evenFloor(width), evenFloor(height)]
}

function getVideoCodecHint(settings: Settings): VideoFormats {
    let videoCodecHint = emptyVideoCodecs()
    if (settings.videoCodec == "h264") {
        videoCodecHint.h264 = true
        videoCodecHint.h264High8444 = true
    } else if (settings.videoCodec == "h265") {
        videoCodecHint.h265 = true
        videoCodecHint.h265Main10 = true
        videoCodecHint.h265Rext8444 = true
        videoCodecHint.h265Rext10444 = true
    } else if (settings.videoCodec == "av1") {
        videoCodecHint.av1Main8 = true
        videoCodecHint.av1Main10 = true
        videoCodecHint.av1High8444 = true
        videoCodecHint.av1High10444 = true
    } else if (settings.videoCodec == "auto") {
        videoCodecHint = allVideoCodecs()
    }

    // Lightning fork: 10 bit only for HDR (as the official Moonlight clients do). The host
    // takes the best format offered, and a 10 bit SDR stream only costs more to encode and
    // isn't decoded by every phone.
    if (!settings.hdr) {
        videoCodecHint.h265Main10 = false
        videoCodecHint.h265Rext10444 = false
        videoCodecHint.av1Main10 = false
        videoCodecHint.av1High10444 = false
    }

    if (isFirefox()) {
        videoCodecHint.av1Main8 = false
        videoCodecHint.av1Main10 = false
    }

    return videoCodecHint
}

function isFirefox(): boolean {
    return navigator.userAgent.includes("Firefox/")
}

const WEBRTC_CONNECT_TIMEOUT_MS = 15000
const FALLBACK_RECONNECT_DELAY_MS = 500

export class Stream implements Component {
    private logger: Logger = new Logger()

    private api: Api

    private hostId: number
    private appId: number

    private permissions: StreamPermissions
    private settings: Settings

    private divElement = document.createElement("div")
    private eventTarget = new EventTarget()

    private transportOverride: TransportType | null = null

    private videoRenderer: VideoRenderer | null = null
    private audioPlayer: AudioPlayer | null = null

    private input: StreamInput
    private stats: StreamStats

    private streamerSize: [number, number]

    constructor(api: Api, hostId: number, appId: number, settings: Settings, viewerScreenSize: [number, number], permissions: StreamPermissions) {
        this.logger.addInfoListener((info, type) => {
            this.debugLog(info, { type: type ?? undefined })
        })

        this.api = api

        this.hostId = hostId
        this.appId = appId

        this.permissions = permissions
        this.settings = settings

        this.streamerSize = getStreamerSize(settings, viewerScreenSize)

        // Stream Input
        const streamInputConfig = defaultStreamInputConfig()
        Object.assign(streamInputConfig, {
            mouseMode: this.settings.mouseMode,
            mouseScrollMode: this.settings.mouseScrollMode,
            touchMode: this.settings.touchMode,
            localCursorSensitivity: this.settings.localCursorSensitivity,
            controllerConfig: this.settings.controllerConfig
        })
        this.input = new StreamInput(streamInputConfig)

        // Stream Stats
        this.stats = new StreamStats(this.logger)

        this.startConnection()
    }

    private debugLog(message: string, additional?: LogMessageInfo) {
        for (const line of message.split("\n")) {
            const event: InfoEvent = new CustomEvent("stream-info", {
                detail: { type: "addDebugLine", line, additional }
            })

            this.eventTarget.dispatchEvent(event)
        }
    }

    async startConnection() {
        this.debugLog(`Permissions: ${JSON.stringify(this.permissions)}`)
        this.dispatchStage("network")

        const desiredTransport = this.transportOverride ?? this.settings.dataTransport
        this.debugLog(`Using transport: ${desiredTransport}`)

        // Lightning fork: "auto" no longer falls back to the Web Socket transport. That fallback
        // carries the video over the signaling path (a tunnel/CDN in our setup), so a network
        // without a direct path reports it instead. "websocket" can still be picked explicitly.
        if (desiredTransport == "auto" || desiredTransport == "webrtc") {
            await this.tryWebRTCTransport()
        } else if (desiredTransport == "websocket") {
            await this.tryWebSocketTransport()
        }

        this.dispatchFailure(this.wasConnected ? "ended" : "generic")
        this.debugLog("Tried all configured transport options but no connection was possible", { type: "fatal" })
    }

    /// Lightning fork: set once a transport connected, so a later close reads as "ended".
    private wasConnected = false
    private failureSent = false
    private dispatchStage(stage: StreamStage) {
        const event: InfoEvent = new CustomEvent("stream-info", { detail: { type: "stage", stage } })
        this.eventTarget.dispatchEvent(event)
    }
    /// Only the first reason is reported: it's the cause, what follows are consequences.
    private dispatchFailure(reason: StreamFailure) {
        if (this.failureSent) {
            return
        }
        this.failureSent = true

        const event: InfoEvent = new CustomEvent("stream-info", { detail: { type: "failure", reason } })
        this.eventTarget.dispatchEvent(event)
    }

    private transport: Transport | null = null

    private setTransport(transport: Transport) {
        if (this.transport) {
            this.debugLog("Closing old transport")
            this.transport.close()
        }
        this.debugLog("Setting new transport")

        this.transport = transport

        this.input.setControlStream(this.transport.controlStream)
        this.stats.setTransport(this.transport)
    }

    /// Lightning fork: runs the chosen upscaler over the video. Only the video element renderer
    /// (the WebRTC default) supports it for now; anything else keeps the plain picture.
    private enableUpscaling(renderer: VideoRenderer) {
        if (!this.settings.upscaling) {
            return
        }
        if (this.settings.hdr) {
            this.debugLog("Upscaling: not applied with HDR on")
            return
        }
        if (!(renderer instanceof VideoElementRenderer)) {
            this.debugLog(`Upscaling: not available with the ${renderer.implementationName} renderer`)
            return
        }

        const algorithm = this.settings.upscalingAlgorithm
        if (renderer.enableUpscaling(algorithm, this.logger)) {
            this.debugLog(`Upscaling: ${algorithm} active`)
            // Read by the automated end-to-end test (experimentos/fase0-streaming/stream-e2e.js).
            Reflect.set(globalThis, "__lightningUpscaler", renderer.getUpscaler()?.stats)
        } else {
            this.debugLog("Upscaling: WebGL2 unavailable, showing the plain video")
        }
    }

    /// Lightning fork: switch the upscaler while streaming (sidebar), to compare on the device.
    /// "off" shows the browser's own scaling. The stream resolution doesn't change.
    setUpscaling(choice: UpscalingAlgorithm | "off"): boolean {
        const renderer = this.videoRenderer
        if (!(renderer instanceof VideoElementRenderer)) {
            this.debugLog("Upscaling: not available with this renderer")
            return false
        }

        if (choice == "off") {
            renderer.disableUpscaling()
            Reflect.set(globalThis, "__lightningUpscaler", null)
            this.debugLog("Upscaling: off")
            return true
        }

        const ok = renderer.enableUpscaling(choice, this.logger)
        Reflect.set(globalThis, "__lightningUpscaler", renderer.getUpscaler()?.stats ?? null)
        this.debugLog(ok ? `Upscaling: ${choice} active` : "Upscaling: WebGL2 unavailable, showing the plain video")
        return ok
    }

    getUpscalerStats(): UpscalerStats | null {
        const renderer = this.videoRenderer
        return renderer instanceof VideoElementRenderer ? renderer.getUpscaler()?.stats ?? null : null
    }

    private upscalingSizeResolved = false
    private hostDisplay: Promise<GetHostDisplayResponse> | null = null

    /// Lightning fork: the codecs announced, worked out once ("auto" asks the browser which
    /// ones this device decodes in hardware, see codec.ts)
    private codecHint: Promise<VideoFormats> | null = null
    /// The codec the host picked for this stream
    private videoFormat: keyof VideoFormats | null = null

    private resolveCodecHint(): Promise<VideoFormats> {
        if (!this.codecHint) {
            this.codecHint = this.settings.videoCodec == "auto"
                ? autoVideoCodecs(this.settings.hdr).then(({ formats, reason }) => {
                    this.debugLog(`Codec: auto (${reason})`)
                    return formats
                })
                : Promise.resolve(getVideoCodecHint(this.settings))
        }
        return this.codecHint
    }

    getVideoCodec(): CodecFamily | null {
        return this.videoFormat ? codecFamily(this.videoFormat) : null
    }
    usesAutoCodec(): boolean {
        return this.settings.videoCodec == "auto"
    }

    private getHostDisplay(): Promise<GetHostDisplayResponse> {
        if (!this.hostDisplay) {
            this.hostDisplay = apiGetHostDisplay(this.api, { host_id: this.hostId })
            this.hostDisplay.catch(() => { this.hostDisplay = null })
        }
        return this.hostDisplay
    }

    /// Lightning fork: turning upscaling on/off from the in-game menu. When that changes the
    /// resolution to ask the host for (virtual display: upscaling renders a fraction of the
    /// screen), the stream has to be restarted; otherwise (physical monitor: always its own
    /// resolution) the upscaler is just switched live.
    async upscalingNeedsReconnect(on: boolean): Promise<boolean> {
        if (on == this.settings.upscaling) {
            // Back to how this stream was started: its size already fits
            return false
        }

        let size: [number, number] | null = null
        try {
            const display = await this.getHostDisplay()
            if (on) {
                size = this.sizeDecision(display, true)?.size ?? null
            } else {
                size = this.sizeDecision(display, false)?.size ?? getStreamerSize(this.settings, physicalScreenSize())
            }
        } catch (error) {
            this.debugLog(`Upscaling: couldn't query the host display (${error}), switching live`)
        }

        return size != null && (size[0] != this.streamerSize[0] || size[1] != this.streamerSize[1])
    }

    /// Lightning fork: the size taken from the host display, or null to keep the one from the
    /// settings (fixed sizes, unknown host display).
    private sizeDecision(display: GetHostDisplayResponse, upscaling: boolean): UpscalingDecision | null {
        if (upscaling) {
            return upscalingStreamerSize(display, physicalScreenSize(), this.settings.upscalingRenderScale)
        }

        const choice = this.settings.videoSize == "native" ? "full" : this.settings.videoSize
        if (choice == "auto" || choice == "full" || choice == "safe") {
            return deviceStreamerSize(display, choice, getStreamerSize(this.settings, physicalScreenSize()))
        }
        return null
    }

    /// Lightning fork: with upscaling on, or a size taken from this screen, the size to ask for
    /// depends on how the host shows the stream (virtual display and its modes, or the physical
    /// monitor; see upscaling.ts). Runs once; on any failure the size from the settings is kept.
    private async resolveUpscalingSize() {
        const fromScreen = ["auto", "full", "safe", "native"].includes(this.settings.videoSize)
        if (this.upscalingSizeResolved || !(this.settings.upscaling || fromScreen)) {
            return
        }
        this.upscalingSizeResolved = true

        const label = this.settings.upscaling ? "Upscaling" : "Resolution"
        try {
            const display = await this.getHostDisplay()
            const decision = this.sizeDecision(display, this.settings.upscaling)
            if (!decision) {
                this.debugLog(`${label}: host display unknown (${JSON.stringify(display)}), keeping ${this.streamerSize[0]}x${this.streamerSize[1]}`)
                return
            }

            this.streamerSize = decision.size
            this.debugLog(`${label}: requesting ${decision.size[0]}x${decision.size[1]} (${decision.reason})`)
        } catch (error) {
            this.debugLog(`${label}: couldn't query the host display (${error}), keeping ${this.streamerSize[0]}x${this.streamerSize[1]}`)
        }
    }

    private async createTransportOptions(): Promise<TransportOptions | null> {
        await this.resolveUpscalingSize()

        const codecHint = await this.resolveCodecHint()

        const dataCodecs = await this.queryVideoCodecs("data")

        if (!hasAnyCodec(codecHint)) {
            this.debugLog("Couldn't find any supported video format. Change the codec option to H264 in the settings if you're unsure which codecs are supported.", { type: "fatalDescription" })
            this.dispatchFailure("codec")
            return null
        }

        return {
            hostId: this.hostId,
            appId: this.appId,
            width: this.streamerSize[0],
            height: this.streamerSize[1],
            fps: this.settings.fps,
            bitrate: this.settings.bitrate,
            hdr: this.settings.hdr,
            localAudioPlayMode: this.settings.playAudioLocal,
            supportedCodecs: dataCodecs,
            preferredCodecs: codecHint,
        }
    }

    private async tryWebRTCTransport(): Promise<TransportShutdown> {
        if (!this.permissions.allow_transport_webrtc) {
            this.debugLog("Not trying WebRTC transport because permissions disallow it")
            return "failednoconnect"
        }

        this.debugLog("Trying WebRTC transport")

        // Get configuration
        const config = await apiWebRTCConfiguration(this.api)

        // Probe the network first with a data-channel-only connection. The host never starts
        // streaming for it, so a network that cannot connect directly doesn't wake Sunshine.
        this.debugLog("Received WebRTC Config, probing direct connection")

        const probe = await probeDirectConnection(this.api, { iceServers: config.iceServers }, this.logger)
        if (!probe.connected) {
            this.debugLog(`Direct connection probe failed (${probe.reason}): this network cannot reach the host directly, so the stream was not started`, { type: "ifErrorDescription" })
            this.dispatchFailure("noDirectPath")
            return "failednoconnect"
        }

        this.debugLog(`Direct connection probe succeeded (local ${probe.localType}, remote ${probe.remoteType}), creating transport`)

        // Create transport
        const transport = new WebRTCTransport(
            this.api,
            {
                iceServers: config.iceServers,
            },
            this.logger
        )
        transport.controlStream.onreceive = this.boundReceivePacket

        const onConnect = new Promise<TransportConnectData>(resolve => {
            transport.onconnect = resolve
        })
        const onClose = new Promise<TransportShutdown>(resolve => {
            transport.onclose = resolve
        })

        const options = await this.createTransportOptions()
        if (!options) {
            return "failednoconnect"
        }

        this.dispatchStage("starting")

        try {
            // Create offer
            const offer = await transport.createOffer(options)

            // Send Request
            this.debugLog("Sending Offer and waiting for Answer")
            const answer = await apiWebRTCOffer(this.api, offer)
            this.debugLog("Got Response")

            // Apply answer
            await transport.setAnswer(answer)
        } catch (error) {
            this.debugLog(`failed to connect using webrtc because ${error}`)
            this.dispatchFailure(isCodecError(error) ? "codec" : "host")

            await transport.close()
            return "failednoconnect"
        }

        // Set Transport
        this.setTransport(transport)

        // Wait for negotiation, but don't let a stuck ICE check block fallback forever.
        const onTimeout: Promise<TransportShutdown> =
            wait(WEBRTC_CONNECT_TIMEOUT_MS)
                .then(() => "failednoconnect")

        const connectData: TransportShutdown | TransportConnectData = await Promise.race([
            onConnect,
            onClose,
            onTimeout,
        ])
        if (typeof connectData == "string") {
            this.debugLog(`webrtc connection failed: ${connectData}`)
            this.dispatchFailure("timeout")
            await transport.close()
            // connection failed
            return connectData
        }

        // -- Connection successful
        await this.onConnect(connectData)

        return await onClose
    }
    private async tryWebSocketTransport() {
        if (!this.permissions.allow_transport_websockets) {
            this.debugLog("Not trying WebSocket transport becaues permissions disallow it")
            return
        }

        this.debugLog("Trying Web Socket transport")

        const options = await this.createTransportOptions()
        if (!options) {
            return
        }

        const transport = new WebSocketTransport(this.api, this.logger)

        // Add listeners
        transport.controlStream.onreceive = this.boundReceivePacket

        const onConnect = new Promise<TransportConnectData>(resolve => {
            transport.onconnect = resolve
        })
        const onClose = new Promise<TransportShutdown>(resolve => {
            transport.onclose = resolve
        })

        // Start stream
        await transport.startStream(options)

        this.setTransport(transport)

        const connectData = await Promise.race([
            onConnect,
            onClose,
        ])

        if (typeof connectData == "string") {
            this.debugLog(`web socket connection failed: ${connectData}`)
            await transport.close()
            // connection failed
            return connectData
        }

        // -- Connection successful
        this.onConnect(connectData)

        return await onClose
    }

    private async onConnect(connectData: TransportConnectData) {
        this.logger.debug("connected successfully, creating video and audio pipelines")
        this.wasConnected = true
        this.videoFormat = connectData.videoSetup.codec
        this.dispatchStage("video")

        // Dispatch app event
        let event: InfoEvent = new CustomEvent("stream-info", {
            detail: {
                type: "app", appName: connectData.appName
            }
        })
        this.eventTarget.dispatchEvent(event)

        // Set input
        this.input.onStreamStart(connectData.capabilities, [connectData.videoSetup.width, connectData.videoSetup.height])

        // Create pipelines
        await this.createPipelines(connectData)

        event = new CustomEvent("stream-info", {
            detail: {
                type: "connectionComplete", capabilities: {
                    // TODO
                    touch: true
                }
            }
        })
        this.eventTarget.dispatchEvent(event)
    }

    private async createPipelines(connectData: TransportConnectData): Promise<void> {
        // Print supported pipes
        const pipesInfo = await gatherPipeInfo()

        this.logger.debug(`Supported Pipes: {`)
        let isFirst = true
        for (const [pipe, info] of pipesInfo) {
            this.logger.debug(`${isFirst ? "" : ","}"${pipeName(pipe)}": ${JSON.stringify(info)}`)
            isFirst = false
        }
        this.logger.debug(`}`)

        const codecSupport = emptyVideoCodecs()
        codecSupport[connectData.videoSetup.codec] = true

        // Create pipelines
        await Promise.all([
            this.createVideoRenderer(connectData.videoType, connectData.videoSetup),
            this.createAudioPlayer(connectData.audioType, connectData.audioSetup)
        ])

        const videoPipelineName = `${connectData.videoType} (transport) -> ${this.videoRenderer?.implementationName} (renderer)`
        this.debugLog(`Using video pipeline: ${videoPipelineName}`)

        const audioPipelineName = `${connectData.audioType} (transport) -> ${this.audioPlayer?.implementationName} (player)`
        this.debugLog(`Using audio pipeline: ${audioPipelineName}`)

        this.stats.setVideoPipeline(videoPipelineName, this.videoRenderer)
        this.stats.setAudioPipeline(audioPipelineName, this.audioPlayer)
    }

    private async queryVideoCodecs(type: "videotrack" | "data"): Promise<VideoFormats> {
        const codecHint = await this.resolveCodecHint()

        const videoSettings: VideoPipelineOptions = {
            supportedVideoCodecs: codecHint,
            canvasRenderer: this.settings.canvasRenderer,
            forceVideoElementRenderer: this.settings.forceVideoElementRenderer,
            canvasVsync: this.settings.canvasVsync
        }

        const info = await queryVideoPipelineInfo(type, videoSettings, this.logger)
        if (!info) {
            this.logger.debug("failed to query video pipelines for information! Disabling high codecs. This could lead to no video being visible!")
            const baseCodecs = {
                h264: true,
                h264High8444: true,
                h265: true,
                h265Main10: true,
                h265Rext8444: true,
                h265Rext10444: true,
                av1Main8: true,
                av1Main10: true,
                av1High8444: true,
                av1High10444: true
            }

            videoSettings.supportedVideoCodecs = andVideoCodecs(codecHint, baseCodecs)
        }

        return info?.supportedVideoCodecs ?? emptyVideoCodecs()
    }
    private async createVideoRenderer(videoType: TransportVideoType, videoSetup: VideoRendererSetup): Promise<boolean> {
        if (this.videoRenderer) {
            this.debugLog("Found an old video renderer -> cleaning it up")

            this.videoRenderer.unmount(this.divElement)
            this.videoRenderer.cleanup()
            this.videoRenderer = null
        }
        if (!this.transport) {
            this.debugLog("Failed to setup video without transport")
            return false
        }

        const supportedVideoCodecs = emptyVideoCodecs()
        if (videoType == "videotrack") {
            // Lightning fork: a WebRTC track is decoded by the browser's own WebRTC stack, which
            // announced the codec itself; the renderer only shows the track. Pick the pipeline
            // as before, when the transport always reported "h264", instead of checking the
            // real codec against <video> MP4 support (unrelated, and it can say no on iOS).
            supportedVideoCodecs.h264 = true
        } else {
            supportedVideoCodecs[videoSetup.codec] = true
        }

        const videoSettings: VideoPipelineOptions = {
            supportedVideoCodecs,
            canvasRenderer: this.settings.canvasRenderer,
            forceVideoElementRenderer: this.settings.forceVideoElementRenderer,
            canvasVsync: this.settings.canvasVsync
        }

        let pipelineCodecSupport
        if (videoType == "videotrack") {
            const { videoRenderer, supportedCodecs, error } = await buildVideoPipeline("videotrack", videoSettings, this.logger)

            if (error) {
                return false
            }
            pipelineCodecSupport = supportedCodecs

            videoRenderer.mount(this.divElement)
            this.enableUpscaling(videoRenderer)

            await videoRenderer.setup(videoSetup)
            await this.transport.setVideoPipeline("videotrack", videoRenderer)

            this.videoRenderer = videoRenderer
        } else if (videoType == "data") {
            const { videoRenderer, supportedCodecs, error } = await buildVideoPipeline("data", videoSettings, this.logger)

            if (error) {
                return false
            }
            pipelineCodecSupport = supportedCodecs

            videoRenderer.mount(this.divElement)

            await videoRenderer.setup(videoSetup)
            await this.transport.setVideoPipeline("data", videoRenderer)

            this.videoRenderer = videoRenderer
        } else {
            this.debugLog(`Failed to create video pipeline with transport channel of type ${videoType} (${this.transport.implementationName})`)
            return false
        }

        return true
    }
    private async createAudioPlayer(audioType: TransportAudioType, audioSetup: AudioPlayerSetup): Promise<boolean> {
        if (this.audioPlayer) {
            this.debugLog("Found an old audio player -> cleaning it up")

            this.audioPlayer.unmount(this.divElement)
            this.audioPlayer.cleanup()
            this.audioPlayer = null
        }
        if (!this.transport) {
            this.debugLog("Failed to setup audio without transport")
            return false
        }

        if (audioType == "audiotrack") {
            const { audioPlayer, error } = await buildAudioPipeline("audiotrack", {}, this.logger)

            if (error) {
                return false
            }

            audioPlayer.mount(this.divElement)
            await audioPlayer.setup(audioSetup)

            await this.transport.setAudioPipeline("audiotrack", audioPlayer)

            this.audioPlayer = audioPlayer
        } else if (audioType == "data") {
            const { audioPlayer, error } = await buildAudioPipeline("data", {}, this.logger)

            if (error) {
                return false
            }

            audioPlayer.mount(this.divElement)
            await audioPlayer.setup(audioSetup)

            await this.transport.setAudioPipeline("data", audioPlayer)

            this.audioPlayer = audioPlayer
        } else {
            this.debugLog(`Cannot find audio pipeline for transport type "${audioType}"`)
            return false
        }

        return true
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }

    getVideoRenderer(): VideoRenderer | null {
        return this.videoRenderer
    }
    getAudioPlayer(): AudioPlayer | null {
        return this.audioPlayer
    }

    async stop(): Promise<boolean> {
        // Stop transport
        await this.transport?.close()

        return true
    }

    private boundReceivePacket = this.onReceivePacket.bind(this)
    private onReceivePacket(packet: ControlPacket) {
        switch (packet.tag) {
            case ControlPacket_Tags.HdrMode:
                if (this.videoRenderer && this.videoRenderer.setHdrMode) {
                    this.videoRenderer?.setHdrMode(packet.inner.enabled, packet.inner.sunshine)
                }
                break
        }

        this.input.onReceivePacket(packet)
    }

    // -- Class Api
    addInfoListener(listener: InfoEventListener) {
        this.eventTarget.addEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }
    removeInfoListener(listener: InfoEventListener) {
        this.eventTarget.removeEventListener("stream-info", listener as EventListenerOrEventListenerObject)
    }

    getInput(): StreamInput {
        return this.input
    }
    getStats(): StreamStats {
        return this.stats
    }

    getStreamerSize(): [number, number] {
        return this.streamerSize
    }
}
