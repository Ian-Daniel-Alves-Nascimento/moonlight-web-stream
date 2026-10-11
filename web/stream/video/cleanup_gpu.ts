/*
 * Picture cleanup in WebGPU for the Lightning fork of Moonlight Web (shader: cleanup_shaders.ts).
 *
 * The frame is imported from the <video> without a copy (importExternalTexture): in WebGL,
 * copying each frame to a texture blocks ~16.7 ms on an iPhone, and a 120 fps stream ended up
 * drawn at 60. Here the cost is only the shader. A canvas laid over the picture draws each
 * decoded frame cleaned up; it hides while the upscaler shows (which cleans up in its own pass)
 * and turns itself off for good when the device can't keep up. Where the browser draws pages
 * slower than the video (iPhone Safari: ~60 times a second), it stays and the player warns that
 * it limits the picture to that rate (frame_rate.ts).
 *
 * Copyright (c) 2026 the author of Lightning Launcher (github.com/Ian-Daniel-Alves-Nascimento).
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 */

/// <reference types="@webgpu/types" />
import { Logger } from "../log"
import { getStreamRectCorrected } from "./index"
import { CLEAN_WGSL } from "./cleanup_shaders"
import { FrameRateMeter } from "./frame_rate"

/// Frames counted before deciding this device can't keep up
const MIN_FRAMES = 240
/// Share of frames that arrive while the GPU still has two earlier ones to finish
const LATE_LIMIT = 0.3
/// Drawing a frame (on the CPU) may take this share of the video's frame time
const SUBMIT_LIMIT = 0.75

const SHADER = `
struct Params { texel: vec2f, unused: vec2f }
@group(0) @binding(0) var src: texture_external;
@group(0) @binding(1) var smp: sampler;
@group(0) @binding(2) var<uniform> p: Params;
fn srcSample(uv: vec2f) -> vec3f { return textureSampleBaseClampToEdge(src, smp, uv).rgb; }
${CLEAN_WGSL}

struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
    var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
    var o: Out;
    o.pos = vec4f(corners[i], 0.0, 1.0);
    o.uv = vec2f((corners[i].x + 1.0) * 0.5, (1.0 - corners[i].y) * 0.5);
    return o;
}
@fragment fn fs(o: Out) -> @location(0) vec4f {
    let c = cleanPixel(o.uv, p.texel) + cleanDither(floor(o.pos.xy)) * (0.5 / 255.0);
    return vec4f(c, 1.0);
}`

export type PictureCleanupStats = {
    frames: number
    /// CPU time to record and submit a frame
    avgSubmitMs: number
    /// Share of frames that arrived with the GPU two frames behind
    lateRatio: number
    /// Frames per second the video decodes, and how many of them get drawn here
    videoFps: number
    drawnFps: number
    /// Hidden while the upscaler shows
    showing: boolean
    gaveUp: boolean
}

export class PictureCleanup {
    /// Null where there's no WebGPU (the WebGL cleanup is the fallback).
    static async create(video: HTMLVideoElement, logger?: Logger): Promise<PictureCleanup | null> {
        try {
            if (!("gpu" in navigator)) {
                return null
            }
            const adapter = await navigator.gpu.requestAdapter()
            if (!adapter) {
                return null
            }
            const device = await adapter.requestDevice()
            return new PictureCleanup(video, device, logger)
        } catch (error) {
            logger?.debug(`Picture cleanup (WebGPU) unavailable: ${error}`)
            return null
        }
    }

    readonly canvas = document.createElement("canvas")
    readonly stats: PictureCleanupStats = {
        frames: 0, avgSubmitMs: 0, lateRatio: 0, videoFps: 0, drawnFps: 0, showing: false, gaveUp: false,
    }
    /// True while something else draws the picture (the upscaler): this canvas hides
    skip: (() => boolean) | null = null
    /// Called once when this device can't keep up and the cleanup turned itself off
    onGaveUp: (() => void) | null = null
    /// Drawn vs the video's frame rate (the connection tells the video's where Safari doesn't)
    readonly meter: FrameRateMeter

    private context: GPUCanvasContext
    private pipeline: GPURenderPipeline
    private sampler: GPUSampler
    private params: GPUBuffer
    private running = false
    private lost = false
    private errorLogged = false
    private pending = 0
    private lateAverage = 0

    private constructor(private video: HTMLVideoElement, private device: GPUDevice, private logger?: Logger) {
        this.meter = new FrameRateMeter(video)
        const context = this.canvas.getContext("webgpu")
        if (!context) {
            throw "no WebGPU canvas"
        }
        this.context = context
        const format = navigator.gpu.getPreferredCanvasFormat()
        context.configure({ device, format, alphaMode: "opaque" })

        this.canvas.classList.add("video-cleanup")
        Object.assign(this.canvas.style, {
            position: "fixed",
            pointerEvents: "none",
            left: "0px",
            top: "0px",
            width: "0px",
            height: "0px",
            visibility: "hidden",
        })

        const module = device.createShaderModule({ code: SHADER })
        this.pipeline = device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint: "fs", targets: [{ format }] },
        })
        this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })
        this.params = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

        device.lost.then(info => {
            if (this.running) {
                this.logger?.debug(`Picture cleanup: GPU lost (${info.message}), showing the plain picture`)
            }
            this.lost = true
            this.unmount()
        })
    }

    /// Right over the video (the upscaler's and Auto HDR's canvases go above it).
    mount() {
        if (this.lost || this.stats.gaveUp) {
            return
        }
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
    destroy() {
        this.unmount()
        this.params.destroy()
        this.device.destroy()
    }

    private scheduleNextFrame() {
        if (!this.running) {
            return
        }
        if ("requestVideoFrameCallback" in this.video) {
            this.video.requestVideoFrameCallback(() => this.onVideoFrame())
        } else {
            requestAnimationFrame(() => this.onVideoFrame())
        }
    }
    private onVideoFrame() {
        if (!this.running) {
            return
        }
        try {
            this.render()
        } catch (error) {
            if (!this.errorLogged) {
                this.errorLogged = true
                this.logger?.debug(`Picture cleanup: frame failed (${error})`)
            }
        }
        this.scheduleNextFrame()
    }

    private render() {
        const start = performance.now()
        this.meter.tick(start)
        this.stats.videoFps = this.meter.videoFps
        this.stats.drawnFps = this.meter.drawnFps

        const inW = this.video.videoWidth
        const inH = this.video.videoHeight
        if (this.skip?.() || inW <= 0 || inH <= 0) {
            this.show(false)
            return
        }
        const rect = getStreamRectCorrected(this.video.getBoundingClientRect(), [inW, inH])
        if (rect.width <= 0 || rect.height <= 0) {
            this.show(false)
            return
        }

        // The device can't keep up: back to the plain video, for good
        const budgetMs = this.stats.videoFps > 0 ? 1000 / this.stats.videoFps : 0
        const slowSubmit = budgetMs > 0 && this.stats.avgSubmitMs > budgetMs * SUBMIT_LIMIT
        if (this.stats.frames > MIN_FRAMES && (this.stats.lateRatio > LATE_LIMIT || slowSubmit)) {
            this.stats.gaveUp = true
            this.logger?.debug(slowSubmit
                ? `Picture cleanup: off, drawing a frame takes ${this.stats.avgSubmitMs.toFixed(1)} ms for a ${Math.round(this.stats.videoFps)} fps video`
                : `Picture cleanup: off, the GPU can't keep up (${Math.round(this.stats.lateRatio * 100)}% late)`)
            this.show(false)
            this.unmount()
            this.onGaveUp?.()
            return
        }

        const style = this.canvas.style
        style.left = `${rect.left}px`
        style.top = `${rect.top}px`
        style.width = `${rect.width}px`
        style.height = `${rect.height}px`
        // At the screen's physical pixels: the browser's own scaling of the video would
        // otherwise come after the cleanup and soften it
        const ratio = window.devicePixelRatio || 1
        const outW = Math.max(1, Math.round(rect.width * ratio))
        const outH = Math.max(1, Math.round(rect.height * ratio))
        if (this.canvas.width != outW || this.canvas.height != outH) {
            this.canvas.width = outW
            this.canvas.height = outH
        }

        // Two frames still on the GPU when a third arrives: this one is late
        const late = this.pending > 1
        this.lateAverage = this.lateAverage * 0.98 + (late ? 0.02 : 0)
        this.stats.lateRatio = this.lateAverage

        const device = this.device
        device.queue.writeBuffer(this.params, 0, new Float32Array([1 / inW, 1 / inH, 0, 0]))
        const bindGroup = device.createBindGroup({
            layout: this.pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: device.importExternalTexture({ source: this.video }) },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: { buffer: this.params } },
            ],
        })
        const encoder = device.createCommandEncoder()
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: this.context.getCurrentTexture().createView(), loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
        })
        pass.setPipeline(this.pipeline)
        pass.setBindGroup(0, bindGroup)
        pass.draw(3)
        pass.end()
        device.queue.submit([encoder.finish()])
        this.pending++
        device.queue.onSubmittedWorkDone().then(() => this.pending--, () => this.pending--)
        this.show(true)

        const submitMs = performance.now() - start
        this.stats.frames++
        this.stats.avgSubmitMs = this.stats.frames == 1 ? submitMs : this.stats.avgSubmitMs * 0.95 + submitMs * 0.05
    }

    private show(on: boolean) {
        this.stats.showing = on
        const visibility = on ? "" : "hidden"
        if (this.canvas.style.visibility != visibility) {
            this.canvas.style.visibility = visibility
        }
    }
}
