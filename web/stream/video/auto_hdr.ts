/*
 * Auto HDR for the Lightning fork of Moonlight Web: an SDR stream shown with HDR highlights.
 *
 * A real HDR stream doesn't survive every browser (iPhone Safari's decoder hands WebCodecs and
 * WebGPU an 8-bit SDR frame, highlights already squeezed), and the host's HDR is calibrated for
 * a virtual display, not for this screen. So the host streams SDR (lighter, works with the
 * upscaler) and this device expands only the highlights into the screen's extra brightness:
 * a WebGPU canvas in "extended" tone mapping mode laid over the picture.
 *
 *   - diffuse content (below a knee) is left exactly as it was: faces, menus, the HUD's body;
 *   - above the knee, luminance rises smoothly towards a peak (2-4x SDR white), hue kept;
 *   - large bright areas (a white menu, an overcast sky) get less than small ones (the sun, a
 *     lamp, a reflection): a 1/8 scale luminance map tells how big the bright area is.
 *
 * Source: the <video> itself (imported without a copy) or, with the upscaler on, its canvas.
 * Only where the screen is HDR and the browser accepts the extended mode (iOS 26 Safari,
 * Chrome on Android/desktop with an HDR display).
 *
 * Copyright (c) 2026 the author of Lightning Launcher (github.com/Ian-Daniel-Alves-Nascimento).
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 */

/// <reference types="@webgpu/types" />
import { Logger } from "../log"
import { getStreamRectCorrected } from "./index"

export type AutoHdrStrength = "low" | "medium" | "high"

/// Peak brightness of the strongest highlights, in SDR whites
const PEAK: Record<AutoHdrStrength, number> = { low: 1.8, medium: 2.6, high: 3.6 }
/// Linear luminance where the expansion starts (about 77% in sRGB): below it nothing changes
const KNEE = 0.55
/// How steeply the expansion grows past the knee (2 = only the brightest pixels get much)
const CURVE = 2.0
/// Size of the luminance map (fraction of the output) used to tell big bright areas apart
const LOCAL_SCALE = 8
/// How far around a pixel "is this a big bright area?" looks (fraction of the longer side)
const AREA_RADIUS = 0.04
const CANVAS_FORMAT: GPUTextureFormat = "rgba16float"

let supportCache: Promise<boolean> | null = null

/// The screen is HDR and the browser draws WebGPU canvases past SDR white.
export function autoHdrSupported(): Promise<boolean> {
    if (!supportCache) {
        supportCache = (async () => {
            try {
                if (!matchMedia("(dynamic-range: high)").matches || !("gpu" in navigator)) {
                    return false
                }
                const adapter = await navigator.gpu.requestAdapter()
                if (!adapter) {
                    return false
                }
                const device = await adapter.requestDevice()
                const canvas = document.createElement("canvas")
                const context = canvas.getContext("webgpu")
                if (!context) {
                    device.destroy()
                    return false
                }
                context.configure({ device, format: CANVAS_FORMAT, toneMapping: { mode: "extended" }, alphaMode: "opaque" } as GPUCanvasConfiguration)
                const configuration = (context as any).getConfiguration?.()
                const extended = configuration?.toneMapping?.mode == "extended"
                context.unconfigure()
                device.destroy()
                return extended
            } catch {
                return false
            }
        })()
    }
    return supportCache
}

function shader(external: boolean): string {
    const source = external
        ? `@group(0) @binding(0) var src: texture_external;
           fn srcSample(uv: vec2f) -> vec3f { return textureSampleBaseClampToEdge(src, smp, uv).rgb; }`
        : `@group(0) @binding(0) var src: texture_2d<f32>;
           fn srcSample(uv: vec2f) -> vec3f { return textureSampleLevel(src, smp, uv, 0.0).rgb; }`
    return `
        struct Params { peak: f32, knee: f32, curve: f32, unused: f32, size: vec2f, radius: vec2f }
        @group(0) @binding(1) var smp: sampler;
        @group(0) @binding(2) var<uniform> p: Params;
        @group(0) @binding(3) var areaMap: texture_2d<f32>;
        ${source}

        struct Out { @builtin(position) pos: vec4f, @location(0) uv: vec2f }
        @vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
            var corners = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
            var o: Out;
            o.pos = vec4f(corners[i], 0.0, 1.0);
            o.uv = vec2f((corners[i].x + 1.0) * 0.5, (1.0 - corners[i].y) * 0.5);
            return o;
        }

        fn toLinear(c: vec3f) -> vec3f {
            return select(pow((c + 0.055) / 1.055, vec3f(2.4)), c / 12.92, c <= vec3f(0.04045));
        }
        fn toSrgb(c: vec3f) -> vec3f {
            // extended sRGB: the same curve keeps going past 1.0
            return select(1.055 * pow(c, vec3f(1.0 / 2.4)) - 0.055, c * 12.92, c <= vec3f(0.0031308));
        }
        fn luma(c: vec3f) -> f32 { return dot(c, vec3f(0.2126, 0.7152, 0.0722)); }

        // Pass 1: luminance map at 1/${LOCAL_SCALE} scale, each texel the mean of a 4x4 grid
        @fragment fn fsLocal(o: Out) -> @location(0) vec4f {
            var sum = 0.0;
            let texel = ${LOCAL_SCALE}.0 / p.size;
            for (var y = 0; y < 4; y++) {
                for (var x = 0; x < 4; x++) {
                    let offset = (vec2f(f32(x), f32(y)) - 1.5) * texel / 4.0;
                    sum += luma(toLinear(srcSample(o.uv + offset)));
                }
            }
            return vec4f(sum / 16.0, 0.0, 0.0, 1.0);
        }

        // Pass 2: expand the highlights
        @fragment fn fsMain(o: Out) -> @location(0) vec4f {
            let color = toLinear(srcSample(o.uv));
            let l = luma(color);
            let t = clamp((l - p.knee) / (1.0 - p.knee), 0.000001, 1.0);
            // Big bright areas (menus, a white wall) rise less than small highlights
            // mean brightness in a ring about 4% of the screen wide: a lamp or a reflection sits
            // in darker surroundings, a menu or the sky doesn't
            var around = 0.0;
            for (var y = -1; y <= 1; y++) {
                for (var x = -1; x <= 1; x++) {
                    around += textureSampleLevel(areaMap, smp, o.uv + vec2f(f32(x), f32(y)) * p.radius, 0.0).r;
                }
            }
            around = around / 9.0;
            let area = 1.0 - 0.6 * smoothstep(0.45, 0.9, around);
            let boosted = l + (p.peak - 1.0) * pow(t, p.curve) * area * step(p.knee, l);
            let scale = select(boosted / l, 1.0, l < 0.0001);
            return vec4f(toSrgb(color * scale), 1.0);
        }`
}

type Pipelines = { local: GPURenderPipeline, main: GPURenderPipeline }

export class AutoHdr {
    /// Null when the device can't (not HDR, no WebGPU, extended mode refused).
    static async create(video: HTMLVideoElement, strength: AutoHdrStrength, logger?: Logger): Promise<AutoHdr | null> {
        try {
            if (!(await autoHdrSupported())) {
                return null
            }
            const adapter = await navigator.gpu.requestAdapter()
            if (!adapter) {
                return null
            }
            const device = await adapter.requestDevice()
            return new AutoHdr(video, device, strength, logger)
        } catch (error) {
            logger?.debug(`Auto HDR unavailable: ${error}`)
            return null
        }
    }

    readonly canvas = document.createElement("canvas")

    private context: GPUCanvasContext
    private sampler: GPUSampler
    private params: GPUBuffer
    private external: Pipelines
    private texture2d: Pipelines
    private localTexture: GPUTexture | null = null
    private copyTexture: GPUTexture | null = null
    private running = false
    private lost = false
    private errorLogged = false
    /// The upscaler's canvas while it shows (the upscaler then calls renderFrom after each frame)
    private upscaledSource: (() => HTMLCanvasElement | null) | null = null

    private constructor(private video: HTMLVideoElement, private device: GPUDevice, private strength: AutoHdrStrength, private logger?: Logger) {
        const context = this.canvas.getContext("webgpu")
        if (!context) {
            throw "no WebGPU canvas"
        }
        this.context = context
        context.configure({ device, format: CANVAS_FORMAT, colorSpace: "srgb", toneMapping: { mode: "extended" }, alphaMode: "opaque" } as GPUCanvasConfiguration)

        this.canvas.classList.add("video-auto-hdr")
        Object.assign(this.canvas.style, {
            position: "fixed",
            pointerEvents: "none",
            left: "0px",
            top: "0px",
            width: "0px",
            height: "0px",
        })

        this.sampler = device.createSampler({ magFilter: "linear", minFilter: "linear" })
        this.params = device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
        this.external = this.createPipelines(true)
        this.texture2d = this.createPipelines(false)

        device.lost.then(info => {
            this.lost = true
            this.logger?.debug(`Auto HDR: GPU lost (${info.message}), showing the plain picture`)
            this.unmount()
        })
    }

    private createPipelines(external: boolean): Pipelines {
        const module = this.device.createShaderModule({ code: shader(external) })
        const make = (entryPoint: string, format: GPUTextureFormat) => this.device.createRenderPipeline({
            layout: "auto",
            vertex: { module, entryPoint: "vs" },
            fragment: { module, entryPoint, targets: [{ format }] },
        })
        return { local: make("fsLocal", "r16float"), main: make("fsMain", CANVAS_FORMAT) }
    }

    setStrength(strength: AutoHdrStrength) {
        this.strength = strength
    }
    getStrength(): AutoHdrStrength {
        return this.strength
    }
    /// With the upscaler on, its canvas is the source (HDR and FSR together)
    setUpscaledSource(source: (() => HTMLCanvasElement | null) | null) {
        this.upscaledSource = source
    }

    /// Lays the canvas over the picture: after the video and after the upscaler's canvas.
    mount(after: Element) {
        if (this.lost) {
            return
        }
        after.insertAdjacentElement("afterend", this.canvas)
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
        this.localTexture?.destroy()
        this.copyTexture?.destroy()
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
        // The upscaler draws first and hands its canvas over (renderFrom); otherwise the video
        if (!this.upscaledSource?.()) {
            this.guard(() => this.render(null))
        }
        this.scheduleNextFrame()
    }
    /// Called by the upscaler right after it drew a frame.
    renderFrom(upscaled: HTMLCanvasElement) {
        if (this.running) {
            this.guard(() => this.render(upscaled))
        }
    }
    private guard(draw: () => void) {
        try {
            draw()
        } catch (error) {
            if (!this.errorLogged) {
                this.errorLogged = true
                this.logger?.debug(`Auto HDR: frame failed (${error})`)
            }
        }
    }

    private render(upscaled: HTMLCanvasElement | null) {
        const inW = this.video.videoWidth
        const inH = this.video.videoHeight
        if (inW <= 0 || inH <= 0) {
            return
        }
        const rect = getStreamRectCorrected(this.video.getBoundingClientRect(), [inW, inH])
        if (rect.width <= 0 || rect.height <= 0) {
            return
        }
        const style = this.canvas.style
        style.left = `${rect.left}px`
        style.top = `${rect.top}px`
        style.width = `${rect.width}px`
        style.height = `${rect.height}px`
        const ratio = window.devicePixelRatio || 1
        const outW = Math.max(1, Math.round(rect.width * ratio))
        const outH = Math.max(1, Math.round(rect.height * ratio))
        if (this.canvas.width != outW || this.canvas.height != outH) {
            this.canvas.width = outW
            this.canvas.height = outH
        }

        const device = this.device
        const localW = Math.max(1, Math.ceil(outW / LOCAL_SCALE))
        const localH = Math.max(1, Math.ceil(outH / LOCAL_SCALE))
        if (!this.localTexture || this.localTexture.width != localW || this.localTexture.height != localH) {
            this.localTexture?.destroy()
            this.localTexture = device.createTexture({
                size: [localW, localH], format: "r16float",
                usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
            })
        }

        // The source: the video imported as is, or the upscaler's canvas copied in
        let pipelines: Pipelines
        let sourceResource: GPUBindingResource
        if (upscaled) {
            if (!this.copyTexture || this.copyTexture.width != upscaled.width || this.copyTexture.height != upscaled.height) {
                this.copyTexture?.destroy()
                this.copyTexture = device.createTexture({
                    size: [upscaled.width, upscaled.height], format: "rgba8unorm",
                    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
                })
            }
            device.queue.copyExternalImageToTexture({ source: upscaled }, { texture: this.copyTexture }, [upscaled.width, upscaled.height])
            pipelines = this.texture2d
            sourceResource = this.copyTexture.createView()
        } else {
            pipelines = this.external
            sourceResource = device.importExternalTexture({ source: this.video })
        }

        // Each local texel averages a 4x4 grid spread over LOCAL_SCALE output pixels
        device.queue.writeBuffer(this.params, 0, new Float32Array([
            PEAK[this.strength], KNEE, CURVE, 0,
            outW, outH, AREA_RADIUS * Math.max(outW, outH) / outW, AREA_RADIUS * Math.max(outW, outH) / outH,
        ]))

        const encoder = device.createCommandEncoder()
        const passes: Array<[GPURenderPipeline, GPUTextureView, boolean]> = [
            [pipelines.local, this.localTexture.createView(), false],
            [pipelines.main, this.context.getCurrentTexture().createView(), true],
        ]
        for (const [pipeline, view, main] of passes) {
            const entries: Array<GPUBindGroupEntry> = [
                { binding: 0, resource: sourceResource },
                { binding: 1, resource: this.sampler },
                { binding: 2, resource: { buffer: this.params } },
            ]
            if (main) {
                entries.push({ binding: 3, resource: this.localTexture.createView() })
            }
            const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries })
            const pass = encoder.beginRenderPass({
                colorAttachments: [{ view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
            })
            pass.setPipeline(pipeline)
            pass.setBindGroup(0, bindGroup)
            pass.draw(3)
            pass.end()
        }
        device.queue.submit([encoder.finish()])
    }
}
