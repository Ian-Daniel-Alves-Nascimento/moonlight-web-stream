/*
 * Client-side upscaling for the Lightning fork of Moonlight Web.
 *
 * The host renders and streams fewer pixels (see ../upscaling.ts); this draws the <video>
 * through an upscaler onto a WebGL2 canvas laid exactly over the picture, at the screen's
 * physical resolution. The video element keeps decoding and keeps the layout (input mapping
 * reads its rect); the canvas ignores pointer events so input still reaches the page.
 *
 * Shaders: ./upscale_shaders.ts (adapted from MoonlightWeb by Bruno Martin, GPL-3.0-or-later).
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 */

import { UpscalingAlgorithm } from "../../component/settings_menu"
import { Logger } from "../log"
import { getStreamRectCorrected } from "./index"
import { nisCoefTexture, nisConfig, nisScaleInRange } from "./upscale_nis_tables"
import { BLIT_FS, EASU_FS, NIS_FS, RCAS_FS, SGSR_FS, VS } from "./upscale_shaders"
import { UpscalingGovernor, UpscalingLevel } from "./upscale_governor"

type Program = {
    program: WebGLProgram
    uniforms: Record<string, WebGLUniformLocation | null>
}

export type UpscalerStats = {
    /// What was picked: an upscaler, or "auto" (the governor picks the level).
    algorithm: UpscalingAlgorithm
    /// What actually ran on the last frame (NIS falls back to FSR 1 outside its 2× range);
    /// null while "auto" has turned the upscaling off.
    lastAlgorithm: UpscalingLevel | null
    frames: number
    input: [number, number]
    output: [number, number]
    /// CPU time to record and submit the passes (the GPU runs them asynchronously).
    lastSubmitMs: number
    avgSubmitMs: number
    /// GPU time of the passes (only where the browser can measure it).
    gpuMs: number | null
    /// Share of frames that arrived before the GPU had finished the previous one.
    lateRatio: number
    /// "auto": why the level last changed.
    governorReason: string
}

/// Lightning fork: the level that worked is remembered on this device, per stream size and
/// screen size, and the next stream starts from it.
const LEVEL_STORAGE_PREFIX = "ltUpscaleLevel:"

/// NIS neutral sharpness (SDK slider, 0..1).
const NIS_SHARPNESS = 0.5

export class VideoUpscaler {
    /// Returns null when WebGL2 is unavailable or a shader fails to build; the caller keeps
    /// showing the plain video.
    static create(video: HTMLVideoElement, algorithm: UpscalingAlgorithm, logger?: Logger): VideoUpscaler | null {
        try {
            return new VideoUpscaler(video, algorithm, logger)
        } catch (error) {
            logger?.debug(`Upscaling unavailable: ${error}`)
            return null
        }
    }

    readonly canvas = document.createElement("canvas")
    readonly stats: UpscalerStats
    /// Lightning fork: called right after each upscaled frame is drawn (Auto HDR takes it from here)
    onRendered: ((canvas: HTMLCanvasElement) => void) | null = null

    private gl: WebGL2RenderingContext
    private vao: WebGLVertexArrayObject
    private inputTex: WebGLTexture
    private intermTex: WebGLTexture
    private fbo: WebGLFramebuffer
    private coefTex: WebGLTexture | null = null

    private easu: Program
    private rcas: Program
    private blit: Program
    private sgsr: Program | null = null
    private nis: Program | null = null

    private inputSize: [number, number] = [0, 0]
    private intermSize: [number, number] = [0, 0]

    private running = false
    private nisRangeWarned = false
    private renderErrorLogged = false

    /// "auto": created on the first frame, once the stream and screen sizes are known.
    private governor: UpscalingGovernor | null = null
    private governorKey = ""
    /// Levels whose shaders failed to build.
    private brokenLevels = new Set<UpscalingLevel>()

    // Measuring whether the passes fit between two frames
    private fence: WebGLSync | null = null
    private timerExt: any = null
    private timerQuery: WebGLQuery | null = null
    private lastFrameTime = 0
    private frameIntervalMs = 1000 / 60
    private lateAverage = 0

    private constructor(private video: HTMLVideoElement, readonly algorithm: UpscalingAlgorithm, private logger?: Logger) {
        this.stats = {
            algorithm,
            lastAlgorithm: null,
            frames: 0,
            input: [0, 0],
            output: [0, 0],
            lastSubmitMs: 0,
            avgSubmitMs: 0,
            gpuMs: null,
            lateRatio: 0,
            governorReason: "",
        }

        const gl = this.canvas.getContext("webgl2", {
            alpha: false,
            antialias: false,
            depth: false,
            stencil: false,
            premultipliedAlpha: false,
            preserveDrawingBuffer: false,
            desynchronized: true,
            powerPreference: "high-performance",
        })
        if (!gl) {
            throw "WebGL2 is not available"
        }
        this.gl = gl

        // Positioned by render(): fixed over the picture, never taking input.
        this.canvas.classList.add("video-upscaler")
        Object.assign(this.canvas.style, {
            position: "fixed",
            pointerEvents: "none",
            left: "0px",
            top: "0px",
            width: "0px",
            height: "0px",
        })

        this.canvas.addEventListener("webglcontextlost", event => {
            event.preventDefault()
            this.logger?.debug("Upscaling: WebGL context lost, showing the plain video")
            this.unmount()
        })

        this.vao = gl.createVertexArray()!
        gl.bindVertexArray(this.vao)

        this.inputTex = this.createTexture(gl.LINEAR)
        this.intermTex = this.createTexture(gl.LINEAR)
        this.fbo = gl.createFramebuffer()!

        this.easu = this.createProgram(EASU_FS, ["uTex", "uRes"])
        this.rcas = this.createProgram(RCAS_FS, ["uTex", "uRes"])
        this.blit = this.createProgram(BLIT_FS, ["uTex"])

        // A picked upscaler must build now (the caller falls back to the plain video);
        // with "auto" the others are built when the governor first needs them.
        if (algorithm == "sgsr" || algorithm == "nis") {
            if (!this.ensureLevelProgram(algorithm)) {
                throw `the ${algorithm} shader failed to build`
            }
        }

        // GPU time where available (desktop Chrome/Edge, some Android); elsewhere only
        // whether the previous frame had finished is known
        this.timerExt = gl.getExtension("EXT_disjoint_timer_query_webgl2")
    }

    /// Builds the extra program a level needs; false when it can't be built.
    private ensureLevelProgram(level: UpscalingLevel): boolean {
        if (this.brokenLevels.has(level)) {
            return false
        }
        try {
            if (level == "sgsr" && !this.sgsr) {
                this.sgsr = this.createProgram(SGSR_FS, ["uTex", "uView"])
            }
            if (level == "nis" && !this.nis) {
                this.nis = this.createProgram(NIS_FS, ["uTex", "uCoef", "uScale", "uDetect", "uSharpA", "uSharpB", "uOut"])

                const gl = this.gl
                this.coefTex = this.createTexture(gl.NEAREST)
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, 4, 64, 0, gl.RGBA, gl.FLOAT, nisCoefTexture())
            }
            return true
        } catch (error) {
            this.brokenLevels.add(level)
            this.logger?.debug(`Upscaling: ${level} unavailable (${error})`)
            return false
        }
    }

    /// Lays the canvas right after the video, so it paints above it and below later UI.
    mount() {
        if (!this.canvas.isConnected) {
            this.video.insertAdjacentElement("afterend", this.canvas)
        }
        if (!this.running) {
            this.running = true
            this.scheduleNextFrame()
        }
    }

    unmount() {
        this.running = false
        this.canvas.remove()
    }

    /// Drawing over the video right now ("auto" may have turned it off for a while)
    isShowing(): boolean {
        return this.running && this.canvas.isConnected && this.canvas.style.visibility != "hidden"
    }

    destroy() {
        this.unmount()

        const gl = this.gl
        for (const program of [this.easu, this.rcas, this.blit, this.sgsr, this.nis]) {
            if (program) {
                gl.deleteProgram(program.program)
            }
        }
        gl.deleteTexture(this.inputTex)
        gl.deleteTexture(this.intermTex)
        if (this.coefTex) {
            gl.deleteTexture(this.coefTex)
        }
        gl.deleteFramebuffer(this.fbo)
        gl.deleteVertexArray(this.vao)
        if (this.fence) {
            gl.deleteSync(this.fence)
        }
        if (this.timerQuery) {
            gl.deleteQuery(this.timerQuery)
        }
    }

    private scheduleNextFrame() {
        if (!this.running) {
            return
        }

        // One draw per decoded frame where supported; otherwise once per display refresh.
        if ("requestVideoFrameCallback" in this.video) {
            this.video.requestVideoFrameCallback(() => this.onFrame())
        } else {
            requestAnimationFrame(() => this.onFrame())
        }
    }

    private onFrame() {
        if (!this.running) {
            return
        }

        try {
            this.render()
            if (this.isShowing()) {
                this.onRendered?.(this.canvas)
            }
        } catch (error) {
            if (!this.renderErrorLogged) {
                this.renderErrorLogged = true
                this.logger?.debug(`Upscaling: frame failed (${error})`)
            }
        }

        this.scheduleNextFrame()
    }

    private render() {
        const gl = this.gl
        const inW = this.video.videoWidth
        const inH = this.video.videoHeight
        if (inW <= 0 || inH <= 0) {
            return
        }

        // Cover exactly the picture area of the video element (letterboxing excluded).
        const rect = getStreamRectCorrected(this.video.getBoundingClientRect(), [inW, inH])
        if (rect.width <= 0 || rect.height <= 0) {
            return
        }
        const style = this.canvas.style
        style.left = `${rect.left}px`
        style.top = `${rect.top}px`
        style.width = `${rect.width}px`
        style.height = `${rect.height}px`

        // Output at the screen's physical pixels: this is where the upscaling happens.
        const ratio = window.devicePixelRatio || 1
        const outW = Math.max(1, Math.round(rect.width * ratio))
        const outH = Math.max(1, Math.round(rect.height * ratio))
        if (this.canvas.width != outW || this.canvas.height != outH) {
            this.canvas.width = outW
            this.canvas.height = outH
        }

        const start = performance.now()
        const sample = this.measure(start)
        const algorithm = this.pickLevel(inW, inH, outW, outH, sample, start)

        this.stats.input = [inW, inH]
        this.stats.output = [outW, outH]
        if (algorithm == "off") {
            // "auto" turned it off: the plain video shows through
            this.canvas.style.visibility = "hidden"
            this.stats.lastAlgorithm = null
            this.stats.gpuMs = null
            return
        }
        this.canvas.style.visibility = ""

        this.beginGpuTimer()
        this.uploadFrame(inW, inH)

        gl.bindVertexArray(this.vao)

        if (algorithm == "fsr1" || algorithm == "sharpen") {
            // Pass 1 into the intermediate texture: EASU (FSR 1) or a plain bilinear stretch.
            this.ensureIntermediate(outW, outH)
            gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
            gl.viewport(0, 0, outW, outH)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, this.inputTex)
            if (algorithm == "fsr1") {
                gl.useProgram(this.easu.program)
                gl.uniform1i(this.easu.uniforms.uTex, 0)
                gl.uniform4f(this.easu.uniforms.uRes, inW, inH, outW, outH)
            } else {
                gl.useProgram(this.blit.program)
                gl.uniform1i(this.blit.uniforms.uTex, 0)
            }
            gl.drawArrays(gl.TRIANGLES, 0, 3)

            // Pass 2 to the canvas: RCAS sharpening.
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.viewport(0, 0, outW, outH)
            gl.bindTexture(gl.TEXTURE_2D, this.intermTex)
            gl.useProgram(this.rcas.program)
            gl.uniform1i(this.rcas.uniforms.uTex, 0)
            gl.uniform4f(this.rcas.uniforms.uRes, outW, outH, 1 / outW, 1 / outH)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
        } else if (algorithm == "sgsr" && this.sgsr) {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.viewport(0, 0, outW, outH)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, this.inputTex)
            gl.useProgram(this.sgsr.program)
            gl.uniform1i(this.sgsr.uniforms.uTex, 0)
            gl.uniform4f(this.sgsr.uniforms.uView, 1 / inW, 1 / inH, inW, inH)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
        } else if (algorithm == "nis" && this.nis && this.coefTex) {
            const config = nisConfig(NIS_SHARPNESS)

            gl.bindFramebuffer(gl.FRAMEBUFFER, null)
            gl.viewport(0, 0, outW, outH)
            gl.activeTexture(gl.TEXTURE0)
            gl.bindTexture(gl.TEXTURE_2D, this.inputTex)
            gl.activeTexture(gl.TEXTURE1)
            gl.bindTexture(gl.TEXTURE_2D, this.coefTex)
            gl.useProgram(this.nis.program)
            gl.uniform1i(this.nis.uniforms.uTex, 0)
            gl.uniform1i(this.nis.uniforms.uCoef, 1)
            gl.uniform4f(this.nis.uniforms.uScale, inW / outW, inH / outH, 1 / inW, 1 / inH)
            gl.uniform4fv(this.nis.uniforms.uDetect, config.detect)
            gl.uniform4fv(this.nis.uniforms.uSharpA, config.sharpA)
            gl.uniform4fv(this.nis.uniforms.uSharpB, config.sharpB)
            gl.uniform2f(this.nis.uniforms.uOut, outW, outH)
            gl.drawArrays(gl.TRIANGLES, 0, 3)
            gl.activeTexture(gl.TEXTURE0)
        }

        this.endGpuTimer()
        // Checked when the next frame arrives: still unsignaled = the passes didn't fit
        this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0)
        gl.flush()

        const submitMs = performance.now() - start
        this.stats.lastAlgorithm = algorithm
        this.stats.frames++
        this.stats.lastSubmitMs = submitMs
        this.stats.avgSubmitMs = this.stats.frames == 1 ? submitMs : this.stats.avgSubmitMs * 0.95 + submitMs * 0.05
    }

    /// What the previous frame cost, read when this one arrives. Null when the timing says
    /// nothing about the GPU: first frame, after a pause, or frames arriving in a burst
    /// (network jitter).
    private measure(now: number) {
        const gl = this.gl

        let late = false
        if (this.fence) {
            late = gl.getSyncParameter(this.fence, gl.SYNC_STATUS) != gl.SIGNALED
            gl.deleteSync(this.fence)
            this.fence = null
        }

        if (this.timerQuery && gl.getQueryParameter(this.timerQuery, gl.QUERY_RESULT_AVAILABLE)) {
            if (!gl.getParameter(this.timerExt.GPU_DISJOINT_EXT)) {
                const ms = gl.getQueryParameter(this.timerQuery, gl.QUERY_RESULT) / 1e6
                this.stats.gpuMs = this.stats.gpuMs == null ? ms : this.stats.gpuMs * 0.9 + ms * 0.1
            }
            gl.deleteQuery(this.timerQuery)
            this.timerQuery = null
        }

        const interval = this.lastFrameTime > 0 ? now - this.lastFrameTime : 0
        this.lastFrameTime = now
        if (interval <= 0 || interval > 250) {
            return null
        }

        const burst = interval < this.frameIntervalMs * 0.6
        this.frameIntervalMs = this.frameIntervalMs * 0.95 + Math.min(50, Math.max(4, interval)) * 0.05
        if (burst) {
            return null
        }

        this.lateAverage = this.lateAverage * 0.98 + (late ? 0.02 : 0)
        this.stats.lateRatio = this.lateAverage
        return { late, gpuMs: this.stats.gpuMs, budgetMs: this.frameIntervalMs }
    }

    /// The picked upscaler, or with "auto" the governor's level for this stream and screen.
    private pickLevel(inW: number, inH: number, outW: number, outH: number,
        sample: ReturnType<VideoUpscaler["measure"]>, now: number): UpscalingLevel {
        if (this.algorithm != "auto") {
            if (this.algorithm == "nis" && !nisScaleInRange(inW / outW, inH / outH)) {
                // NIS is specified for up to 2× upscale and no downscale.
                if (!this.nisRangeWarned) {
                    this.nisRangeWarned = true
                    this.logger?.debug(`Upscaling: NIS works up to 2x (${inW}x${inH} -> ${outW}x${outH}), using FSR 1`)
                }
                return "fsr1"
            }
            return this.algorithm
        }

        const key = `${LEVEL_STORAGE_PREFIX}${inW}x${inH}>${outW}x${outH}`
        if (!this.governor || this.governorKey != key) {
            this.governorKey = key
            const available = (level: UpscalingLevel) => level == "nis"
                ? nisScaleInRange(inW / outW, inH / outH) && this.ensureLevelProgram("nis")
                : level == "sgsr" ? this.ensureLevelProgram("sgsr") : true
            this.governor = new UpscalingGovernor(available, readSavedLevel(key) ?? "fsr1", now)
            this.logger?.debug(`Upscaling: auto starts at ${this.governor.level}`)
        }

        if (sample) {
            const changed = this.governor.onFrame(sample, now)
            if (changed) {
                // A new level has its own cost
                this.stats.gpuMs = null
                this.stats.governorReason = this.governor.lastReason
                this.logger?.debug(`Upscaling: auto -> ${changed} (${this.governor.lastReason})`)
                saveLevel(key, changed)
            }
        }
        return this.governor.level
    }

    private beginGpuTimer() {
        if (this.timerExt && !this.timerQuery) {
            const query = this.gl.createQuery()
            if (query) {
                this.gl.beginQuery(this.timerExt.TIME_ELAPSED_EXT, query)
                this.timerQuery = query
                this.timingThisFrame = true
            }
        }
    }
    private endGpuTimer() {
        if (this.timingThisFrame) {
            this.gl.endQuery(this.timerExt.TIME_ELAPSED_EXT)
            this.timingThisFrame = false
        }
    }
    private timingThisFrame = false

    private uploadFrame(inW: number, inH: number) {
        const gl = this.gl

        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.inputTex)
        if (this.inputSize[0] != inW || this.inputSize[1] != inH) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, inW, inH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
            this.inputSize = [inW, inH]
        }
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.video)
    }

    private ensureIntermediate(width: number, height: number) {
        if (this.intermSize[0] == width && this.intermSize[1] == height) {
            return
        }

        const gl = this.gl
        gl.bindTexture(gl.TEXTURE_2D, this.intermTex)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo)
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.intermTex, 0)
        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        this.intermSize = [width, height]
    }

    private createTexture(filter: number): WebGLTexture {
        const gl = this.gl
        const texture = gl.createTexture()!
        gl.bindTexture(gl.TEXTURE_2D, texture)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
        return texture
    }

    private createProgram(fragmentSource: string, uniformNames: Array<string>): Program {
        const gl = this.gl

        const compile = (type: number, source: string) => {
            const shader = gl.createShader(type)!
            gl.shaderSource(shader, source)
            gl.compileShader(shader)
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                const log = gl.getShaderInfoLog(shader)
                gl.deleteShader(shader)
                throw `shader compile failed: ${log}`
            }
            return shader
        }

        const vertex = compile(gl.VERTEX_SHADER, VS)
        const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource)
        const program = gl.createProgram()!
        gl.attachShader(program, vertex)
        gl.attachShader(program, fragment)
        gl.linkProgram(program)
        gl.deleteShader(vertex)
        gl.deleteShader(fragment)
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(program)
            gl.deleteProgram(program)
            throw `shader link failed: ${log}`
        }

        const uniforms: Record<string, WebGLUniformLocation | null> = {}
        for (const name of uniformNames) {
            uniforms[name] = gl.getUniformLocation(program, name)
        }
        return { program, uniforms }
    }
}

function readSavedLevel(key: string): UpscalingLevel | null {
    try {
        const level = localStorage.getItem(key)
        return level == "fsr1" || level == "nis" || level == "sgsr" || level == "sharpen" || level == "off" ? level : null
    } catch {
        return null
    }
}
function saveLevel(key: string, level: UpscalingLevel) {
    try {
        localStorage.setItem(key, level)
    } catch {
        // Private mode: the next stream starts from FSR 1 again
    }
}
