/*
 * Picture cleanup (GLSL ES 3.00) for the Lightning fork of Moonlight Web: runs on each decoded
 * frame BEFORE the upscaler (whose sharpening otherwise makes compression blocks stand out), or
 * alone straight to the screen when upscaling is off.
 *
 *   1. Flat areas: a neighbour joins the average only if it looks like the pixel, and only where
 *      the whole 3x3 neighbourhood is low contrast, so edges, text and detail are left alone.
 *      Takes the blocks and the "mosquito" noise out of skies, walls and shadows.
 *   2. Deband: four samples spread around the pixel; when all of them are within a few levels of
 *      it, the pixel sits on a smooth gradient that the encoder quantized into steps, and their
 *      average replaces it.
 *   3. Dither: ±0.5 level of fixed noise on an 8-bit output so new steps don't appear.
 *
 * The noise is a stable per-pixel hash (no time): noise that changes every frame shimmers.
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
    vec3 sum = c;
    float wsum = 1.0;
    float lo = lc;
    float hi = lc;
    for (int y = -1; y <= 1; y++) {
        for (int x = -1; x <= 1; x++) {
            if (x == 0 && y == 0) continue;
            vec3 n = texture(uTex, vUv + vec2(float(x), float(y)) * uTexel).rgb;
            float ln = luma(n);
            lo = min(lo, ln);
            hi = max(hi, ln);
            float w = 1.0 - smoothstep(0.015, 0.05, abs(ln - lc));
            sum += n * w;
            wsum += w;
        }
    }
    float flatness = 1.0 - smoothstep(0.04, 0.12, hi - lo);
    c = mix(c, sum / wsum, flatness * 0.85);

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
