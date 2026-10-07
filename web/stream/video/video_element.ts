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
        this.upscaler?.mount()
        this.placeAutoHdr()
    }
    unmount(parent: HTMLElement): void {
        this.autoHdr?.unmount()
        this.upscaler?.unmount()
        parent.removeChild(this.videoElement)
    }

    /// Lightning fork: upscale on this device. Returns false when it can't (no WebGL2, shader
    /// failure); the plain video keeps showing.
    enableUpscaling(algorithm: UpscalingAlgorithm, logger?: Logger): boolean {
        this.upscaler?.destroy()
        this.upscaler = VideoUpscaler.create(this.videoElement, algorithm, logger)
        if (this.upscaler && this.videoElement.isConnected) {
            this.upscaler.mount()
        }
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
        this.placeAutoHdr()
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
        this.placeAutoHdr()
        return true
    }
    disableAutoHdr() {
        this.autoHdr?.destroy()
        this.autoHdr = null
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
