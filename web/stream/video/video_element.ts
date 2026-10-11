import { VideoFormats } from "../../uniffi/moonlight_common_bindings"
import { globalObject } from "../../util"
import { Pipe, PipeInfo } from "../pipeline/index"
import { addPipePassthrough } from "../pipeline/pipes"
import { emptyVideoCodecs, } from "../video"
import { getStreamRectCorrected, TrackVideoRenderer, UrlVideoRenderer, VideoRenderer, VideoRendererSetup } from "./index"
import { UpscalingAlgorithm } from "../../component/settings_menu"
import { Logger } from "../log"
import { VideoUpscaler } from "./upscale"
import { AutoHdr, AutoHdrStrength } from "./auto_hdr"
import { PictureCleanup, PictureCleanupStats } from "./cleanup_gpu"

const VIDEO_DECODER_CODECS: Record<keyof VideoFormats, string> = {
    "h264": "avc1.42E01E",
    "h264High8444": "avc1.640032",
    "h265": "hvc1.1.6.L93.B0",
    "h265Main10": "hvc1.2.4.L120.90",
    "h265Rext8444": "hvc1.6.6.L93.90",
    "h265Rext10444": "hvc1.6.10.L120.90",
    "av1Main8": "av01.0.04M.08",
    "av1Main10": "av01.0.04M.10",
    "av1High8444": "av01.0.08M.08",
    "av1High10444": "av01.0.08M.10"
}

function detectCodecs(): VideoFormats {
    if (!("canPlayType" in HTMLVideoElement.prototype)) {
        return emptyVideoCodecs()
    }

    const codecs = emptyVideoCodecs()

    const testElement = document.createElement("video")

    for (const codec2 in codecs) {
        const codec = codec2 as keyof VideoFormats

        const supported = testElement.canPlayType(`video/mp4; codecs=${VIDEO_DECODER_CODECS[codec]}`)

        if (supported == "probably" || supported == "maybe") {
            codecs[codec] = true
        } else {
            // unsupported
            codecs[codec] = false
        }
    }

    return codecs
}

export class VideoElementRenderer implements TrackVideoRenderer, VideoRenderer {
    static readonly pipeName = "VideoElementRenderer"

    static readonly type = "videotrack"

    static async getInfo(): Promise<PipeInfo> {
        const supported = "HTMLVideoElement" in globalObject() && "srcObject" in HTMLVideoElement.prototype

        return {
            environmentSupported: supported,
            supportedVideoCodecs: supported ? detectCodecs() : emptyVideoCodecs()
        }
    }

    readonly implementationName: string = "video_element"

    private videoElement = document.createElement("video")
    private oldTrack: MediaStreamTrack | null = null
    private stream = new MediaStream()

    private size: [number, number] | null = null
    private hdrEnabled: boolean = false

    /// Lightning fork: draws the video through an upscaler on a canvas laid over it.
    private upscaler: VideoUpscaler | null = null
    /// Lightning fork: HDR highlights over the picture (or over the upscaler), see auto_hdr.ts
    private autoHdr: AutoHdr | null = null
    /// Lightning fork: picture cleanup wanted (cleanup_shaders.ts). Where it runs, see
    /// refreshCleanup: Auto HDR's pass, the upscaler's pass, or its own WebGPU canvas
    private cleanupWanted = false
    private gpuCleanup: PictureCleanup | null = null
    private gpuCleanupStarting = false
    /// No WebGPU here: the WebGL cleanup is the fallback for this stream
    private gpuCleanupFailed = false
    private pipelineLogger?: Logger

    constructor() {
        this.videoElement.classList.add("video-stream")
        this.videoElement.preload = "none"
        this.videoElement.controls = false
        this.videoElement.autoplay = true
        this.videoElement.disablePictureInPicture = true
        this.videoElement.playsInline = true
        this.videoElement.muted = true

        if ("srcObject" in this.videoElement) {
            try {
                this.videoElement.srcObject = this.stream
            } catch (err: any) {
                if (err.name !== "TypeError") {
                    throw err;
                }

                console.error(err)
                throw `video_element renderer not supported: ${err}`
            }
        }

        addPipePassthrough(this)
    }

    async setup(setup: VideoRendererSetup) {
        this.size = [setup.width, setup.height]
    }
    cleanup(): void {
        this.upscaler?.destroy()
        this.upscaler = null
        this.autoHdr?.destroy()
        this.autoHdr = null
        this.gpuCleanup?.destroy()
        this.gpuCleanup = null
        this.cleanupWanted = false

        if (this.oldTrack) {
            this.stream.removeTrack(this.oldTrack)
        }
        this.videoElement.srcObject = null
    }

    setTrack(track: MediaStreamTrack): void {
        if (this.oldTrack) {
            this.stream.removeTrack(this.oldTrack)
        }

        this.stream.addTrack(track)
        this.oldTrack = track
    }

    pollRequestIdr(): boolean {
        return false
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.videoElement)
        this.gpuCleanup?.mount()
        this.upscaler?.mount()
        this.placeAutoHdr()
    }
    unmount(parent: HTMLElement): void {
        this.autoHdr?.unmount()
        this.upscaler?.unmount()
        this.gpuCleanup?.unmount()
        parent.removeChild(this.videoElement)
    }

    /// Lightning fork: upscale on this device. Returns false when it can't (no WebGL2, shader
    /// failure); the plain video keeps showing.
    enableUpscaling(algorithm: UpscalingAlgorithm, logger?: Logger): boolean {
        this.pipelineLogger = logger ?? this.pipelineLogger
        this.upscaler?.destroy()
        this.upscaler = VideoUpscaler.create(this.videoElement, algorithm, logger, this.cleanupWanted)
        if (this.upscaler && this.videoElement.isConnected) {
            this.upscaler.mount()
        }
        this.refreshCleanup()
        this.placeAutoHdr()
        return this.upscaler != null
    }
    getUpscaler(): VideoUpscaler | null {
        return this.upscaler
    }
    /// Back to the browser's own scaling of the <video>.
    disableUpscaling() {
        this.upscaler?.destroy()
        this.upscaler = null
        this.refreshCleanup()
        this.placeAutoHdr()
    }

    /// Lightning fork: picture cleanup on/off, live.
    setCleanup(on: boolean, logger?: Logger) {
        this.pipelineLogger = logger ?? this.pipelineLogger
        this.cleanupWanted = on
        this.refreshCleanup()
        this.placeAutoHdr()
    }
    /// Where the cleanup runs, cheapest first:
    ///   - Auto HDR on: in its pass (its canvas covers the picture, and it imports the video
    ///     without a copy);
    ///   - the upscaler drawing: in its WebGL pass (it copies the frame anyway);
    ///   - otherwise its own WebGPU canvas, frame imported without a copy (cleanup_gpu.ts);
    ///   - no WebGPU: a WebGL cleanup-only upscaler, which turns itself off where copying the
    ///     frame is too slow.
    private refreshCleanup() {
        const want = this.cleanupWanted
        const fullUpscaler = this.upscaler && this.upscaler.algorithm != "none" ? this.upscaler : null
        fullUpscaler?.setCleanup(want)
        this.autoHdr?.setCleanup(want)

        const ownCanvas = want && !this.autoHdr
        // The WebGL cleanup-only upscaler is only the fallback for a device without WebGPU
        if ((!ownCanvas || !this.gpuCleanupFailed) && this.upscaler && this.upscaler.algorithm == "none") {
            this.upscaler.destroy()
            this.upscaler = null
        }
        if (!ownCanvas) {
            this.gpuCleanup?.destroy()
            this.gpuCleanup = null
            return
        }
        if (this.gpuCleanup) {
            // Hidden while the upscaler draws the picture (with the cleanup in its own pass)
            this.gpuCleanup.skip = () => this.upscaler?.isShowing() ?? false
            return
        }
        if (this.gpuCleanupFailed) {
            if (!this.upscaler) {
                this.upscaler = VideoUpscaler.create(this.videoElement, "none", this.pipelineLogger, true)
                if (this.upscaler && this.videoElement.isConnected) {
                    this.upscaler.mount()
                }
            }
            return
        }
        if (this.gpuCleanupStarting) {
            return
        }
        this.gpuCleanupStarting = true
        PictureCleanup.create(this.videoElement, this.pipelineLogger).then(cleanup => {
            this.gpuCleanupStarting = false
            if (!cleanup) {
                this.pipelineLogger?.debug("Picture cleanup: no WebGPU, using WebGL")
                this.gpuCleanupFailed = true
            } else if (!this.cleanupWanted || this.autoHdr || this.gpuCleanup) {
                // Changed while the GPU was starting
                cleanup.destroy()
                return
            } else {
                this.gpuCleanup = cleanup
                cleanup.onGaveUp = () => {
                    // Too slow even without a copy: WebGL would do worse, the plain video shows
                    if (this.gpuCleanup == cleanup) {
                        this.gpuCleanup = null
                        this.gpuCleanupGaveUp = true
                        cleanup.destroy()
                    }
                }
                if (this.videoElement.isConnected) {
                    cleanup.mount()
                }
            }
            this.refreshCleanup()
            this.placeAutoHdr()
        })
    }
    private gpuCleanupGaveUp = false
    /// Lightning fork: where the cleanup runs right now, for the stats.
    getCleanupState(): { where: string, stats: PictureCleanupStats | null } {
        if (!this.cleanupWanted) {
            return { where: "off", stats: null }
        }
        if (this.autoHdr?.isCleaning()) {
            return { where: "in the Auto HDR pass (WebGPU)", stats: null }
        }
        if (this.upscaler?.isShowing() && this.upscaler.isCleanupOn()) {
            return { where: this.upscaler.algorithm == "none" ? "WebGL" : "in the upscaler pass (WebGL)", stats: null }
        }
        if (this.gpuCleanup) {
            return { where: "WebGPU", stats: this.gpuCleanup.stats }
        }
        if (this.gpuCleanupStarting) {
            return { where: "starting", stats: null }
        }
        return { where: this.gpuCleanupGaveUp || this.gpuCleanupFailed ? "off, this device can't keep up" : "off", stats: null }
    }

    /// Lightning fork: HDR highlights on an HDR screen. False when this device can't.
    async enableAutoHdr(strength: AutoHdrStrength, logger?: Logger): Promise<boolean> {
        if (this.autoHdr) {
            this.autoHdr.setStrength(strength)
            return true
        }
        const autoHdr = await AutoHdr.create(this.videoElement, strength, logger)
        if (!autoHdr) {
            return false
        }
        // Another call finished first while this one waited for the GPU: keep that one
        const current = this.autoHdr as AutoHdr | null
        if (current) {
            autoHdr.destroy()
            current.setStrength(strength)
            return true
        }
        this.autoHdr = autoHdr
        this.refreshCleanup()
        this.placeAutoHdr()
        return true
    }
    disableAutoHdr() {
        this.autoHdr?.destroy()
        this.autoHdr = null
        this.refreshCleanup()
        if (this.upscaler) {
            this.upscaler.onRendered = null
        }
    }
    getAutoHdr(): AutoHdr | null {
        return this.autoHdr
    }
    /// Above everything that draws the picture: the video, then the upscaler's canvas. With the
    /// upscaler on, Auto HDR takes each frame from it.
    private placeAutoHdr() {
        const autoHdr = this.autoHdr
        if (!autoHdr) {
            return
        }
        const upscaler = this.upscaler
        if (upscaler) {
            upscaler.onRendered = canvas => autoHdr.renderFrom(canvas)
            autoHdr.setUpscaledSource(() => upscaler.isShowing() ? upscaler.canvas : null)
        } else {
            autoHdr.setUpscaledSource(null)
        }
        if (!this.videoElement.isConnected) {
            return
        }
        autoHdr.unmount()
        autoHdr.mount(upscaler?.canvas.isConnected ? upscaler.canvas : this.videoElement)
    }

    onUserInteraction(): void {
        if (this.videoElement.paused) {
            this.videoElement.play().then(() => {
                // Playing
            }).catch(error => {
                console.error(`Failed to play videoElement: ${error.message || error}`);
            })
        }
    }
    private getEffectiveVideoSize(): [number, number] | null {
        const width = this.videoElement.videoWidth
        const height = this.videoElement.videoHeight
        if (width > 0 && height > 0) {
            return [width, height]
        }

        return this.size
    }
    getStreamRect(): DOMRect {
        const effectiveSize = this.getEffectiveVideoSize()
        if (!effectiveSize) {
            return new DOMRect()
        }

        return getStreamRectCorrected(this.videoElement.getBoundingClientRect(), effectiveSize)
    }

    getBase(): Pipe | null {
        return null
    }

    setHdrMode(enabled: boolean): void {
        this.hdrEnabled = enabled
        // Request HDR display mode if supported
        if (enabled && "requestHDR" in this.videoElement) {
            try {
                (this.videoElement as any).requestHDR()
            } catch (err) {
                console.warn("Failed to request HDR mode:", err)
            }
        }
        // Set color space attributes for HDR
        if (enabled) {
            this.videoElement.setAttribute("color-gamut", "rec2020")
            this.videoElement.setAttribute("transfer-function", "pq")
        } else {
            this.videoElement.removeAttribute("color-gamut")
            this.videoElement.removeAttribute("transfer-function")
        }
    }
}

export class UrlVideoElementRenderer implements UrlVideoRenderer, VideoRenderer {
    static readonly pipeName = "UrlVideoElementRenderer"

    static readonly type = "videourl"

    static async getInfo(): Promise<PipeInfo> {
        const supported = "HTMLVideoElement" in globalObject() && "src" in HTMLVideoElement.prototype

        return {
            environmentSupported: supported,
            supportedVideoCodecs: supported ? detectCodecs() : emptyVideoCodecs()
        }
    }

    readonly implementationName: string = "video_element"

    private videoElement = document.createElement("video")

    private size: [number, number] | null = null

    constructor() {
        this.videoElement.classList.add("video-stream")
        this.videoElement.preload = "none"
        this.videoElement.controls = false
        this.videoElement.autoplay = true
        this.videoElement.disablePictureInPicture = true
        this.videoElement.playsInline = true
        this.videoElement.muted = true

        addPipePassthrough(this)
    }

    async setup(setup: VideoRendererSetup) {
        this.size = [setup.width, setup.height]
    }
    cleanup(): void { }

    setUrl(src: string): void {
        this.videoElement.src = src
    }

    pollRequestIdr(): boolean {
        return false
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.videoElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.videoElement)
    }

    onUserInteraction(): void {
        if (this.videoElement.paused) {
            this.videoElement.play().then(() => {
                // Playing
            }).catch(error => {
                console.error(`Failed to play videoElement: ${error.message || error}`);
            })
        }
    }
    private getEffectiveVideoSize(): [number, number] | null {
        const width = this.videoElement.videoWidth
        const height = this.videoElement.videoHeight
        if (width > 0 && height > 0) {
            return [width, height]
        }

        return this.size
    }
    getStreamRect(): DOMRect {
        const effectiveSize = this.getEffectiveVideoSize()
        if (!effectiveSize) {
            return new DOMRect()
        }

        return getStreamRectCorrected(this.videoElement.getBoundingClientRect(), effectiveSize)
    }

    getBase(): Pipe | null {
        return null
    }

    setHdrMode(enabled: boolean): void {
        // Request HDR display mode if supported
        if (enabled && "requestHDR" in this.videoElement) {
            try {
                (this.videoElement as any).requestHDR()
            } catch (err) {
                console.warn("Failed to request HDR mode:", err)
            }
        }
        // Set color space attributes for HDR
        if (enabled) {
            this.videoElement.setAttribute("color-gamut", "rec2020")
            this.videoElement.setAttribute("transfer-function", "pq")
        } else {
            this.videoElement.removeAttribute("color-gamut")
            this.videoElement.removeAttribute("transfer-function")
        }
    }
}
