/*
 * Picture cleanup for the Lightning fork of Moonlight Web, on each decoded frame: in WebGPU
 * (CLEAN_WGSL, cleanup_gpu.ts and auto_hdr.ts), which reads the video frame without copying it,
 * or in WebGL (CLEAN_FS) inside the upscaler, which copies the frame anyway.
 *
 *   1. Flat areas: four bilinear reads on the diagonals, each the mean of a 2x2 block, together
 *      make the 3x3 tent filter [1 2 1; 2 4 2; 1 2 1]/16 in 4 reads instead of 9. A read that
 *      doesn't look like the pixel is left out (the pixel stands in for it), and only where the
 *      neighbourhood is low contrast: edges, text and detail are left alone. Takes the blocks
 *      and the "mosquito" noise out of skies, walls and shadows.
 *   2. Deband: four samples spread around the pixel; when all of them are within a few levels of
 *      it, the pixel sits on a smooth gradient that the encoder quantized into steps, and their
 *      average replaces it.
 *   3. Dither: ±0.5 level of fixed noise on an 8-bit output so new steps don't appear.
 *
 * 9 texture reads per pixel. The noise is a stable per-pixel hash (no time): noise that changes
 * every frame shimmers.
 *
 * Copyright (c) 2026 the author of Lightning Launcher (github.com/Ian-Daniel-Alves-Nascimento).
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 */

export const CLEAN_FS = `#version 300 es
precision highp float;
uniform sampler2D uTex;
// 1 / the frame's size: the neighbours are the frame's own pixels, whatever the output size
uniform vec2 uTexel;
// 1.0 when this pass draws to the screen (8-bit), 0.0 when it feeds the upscaler
uniform float uDither;
in vec2 vUv;
out vec4 oColor;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float hash(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

void main() {
    vec3 c = texture(uTex, vUv).rgb;
    float lc = luma(c);

    // 1. Flat areas
    vec2 h = uTexel * 0.5;
    vec3 n0 = texture(uTex, vUv + vec2(-h.x, -h.y)).rgb;
    vec3 n1 = texture(uTex, vUv + vec2(h.x, -h.y)).rgb;
    vec3 n2 = texture(uTex, vUv + vec2(-h.x, h.y)).rgb;
    vec3 n3 = texture(uTex, vUv + vec2(h.x, h.y)).rgb;
    vec4 l = vec4(luma(n0), luma(n1), luma(n2), luma(n3));
    vec4 w = 1.0 - smoothstep(vec4(0.01), vec4(0.035), abs(l - lc));
    float range = max(max(max(l.x, l.y), max(l.z, l.w)), lc) - min(min(min(l.x, l.y), min(l.z, l.w)), lc);
    float flatness = 1.0 - smoothstep(0.03, 0.09, range);
    vec3 tent = (n0 * w.x + n1 * w.y + n2 * w.z + n3 * w.w + c * (4.0 - dot(w, vec4(1.0)))) * 0.25;
    c = mix(c, tent, flatness * 0.9);

    // 2. Deband
    vec2 cell = floor(vUv / uTexel);
    float a = hash(cell) * 6.2831853;
    float r = 4.0 + hash(cell + 17.0) * 12.0;
    vec2 d1 = vec2(cos(a), sin(a)) * r * uTexel;
    vec2 d2 = vec2(-d1.y, d1.x);
    vec3 s0 = texture(uTex, vUv + d1).rgb;
    vec3 s1 = texture(uTex, vUv - d1).rgb;
    vec3 s2 = texture(uTex, vUv + d2).rgb;
    vec3 s3 = texture(uTex, vUv - d2).rgb;
    vec3 diff = max(max(abs(s0 - c), abs(s1 - c)), max(abs(s2 - c), abs(s3 - c)));
    float band = 1.0 - smoothstep(0.008, 0.016, max(max(diff.r, diff.g), diff.b));
    c = mix(c, (s0 + s1 + s2 + s3) * 0.25, band);

    // 3. Dither (triangular, ±0.5 level)
    float noise = hash(gl_FragCoord.xy) + hash(gl_FragCoord.xy + 71.0) - 1.0;
    c += noise * (0.5 / 255.0) * uDither;

    oColor = vec4(c, 1.0);
}
`;

/// The same cleanup in WGSL. Needs `fn srcSample(uv: vec2f) -> vec3f` (the frame, in sRGB as
/// decoded) declared by the shader that includes it. `texel` is 1 / the frame's size.
export const CLEAN_WGSL = `
fn cleanLuma(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }
fn cleanHash(q: vec2f) -> f32 {
    var p3 = fract(vec3f(q.x, q.y, q.x) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
/// Triangular noise in -1..1, fixed per screen pixel: times 0.5 / 255 before an 8-bit output
fn cleanDither(pos: vec2f) -> f32 {
    return cleanHash(pos) + cleanHash(pos + 71.0) - 1.0;
}
fn cleanPixel(uv: vec2f, texel: vec2f) -> vec3f {
    var c = srcSample(uv);
    let lc = cleanLuma(c);

    // 1. Flat areas: the 3x3 tent in 4 bilinear reads
    let h = texel * 0.5;
    let n0 = srcSample(uv + vec2f(-h.x, -h.y));
    let n1 = srcSample(uv + vec2f(h.x, -h.y));
    let n2 = srcSample(uv + vec2f(-h.x, h.y));
    let n3 = srcSample(uv + vec2f(h.x, h.y));
    let l = vec4f(cleanLuma(n0), cleanLuma(n1), cleanLuma(n2), cleanLuma(n3));
    let w = 1.0 - smoothstep(vec4f(0.01), vec4f(0.035), abs(l - lc));
    let range = max(max(max(l.x, l.y), max(l.z, l.w)), lc) - min(min(min(l.x, l.y), min(l.z, l.w)), lc);
    let flatness = 1.0 - smoothstep(0.03, 0.09, range);
    let tent = (n0 * w.x + n1 * w.y + n2 * w.z + n3 * w.w + c * (4.0 - dot(w, vec4f(1.0)))) * 0.25;
    c = mix(c, tent, flatness * 0.9);

    // 2. Deband
    let cell = floor(uv / texel);
    let a = cleanHash(cell) * 6.2831853;
    let r = 4.0 + cleanHash(cell + 17.0) * 12.0;
    let d1 = vec2f(cos(a), sin(a)) * r * texel;
    let d2 = vec2f(-d1.y, d1.x);
    let s0 = srcSample(uv + d1);
    let s1 = srcSample(uv - d1);
    let s2 = srcSample(uv + d2);
    let s3 = srcSample(uv - d2);
    let diff = max(max(abs(s0 - c), abs(s1 - c)), max(abs(s2 - c), abs(s3 - c)));
    let band = 1.0 - smoothstep(0.008, 0.016, max(max(diff.r, diff.g), diff.b));
    return mix(c, (s0 + s1 + s2 + s3) * 0.25, band);
}
`;
