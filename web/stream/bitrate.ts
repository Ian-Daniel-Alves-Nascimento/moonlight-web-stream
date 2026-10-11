/*
 * Lightning fork: automatic bitrate.
 *
 * Every stream used to start at 10 Mbps, whatever it asked for: a phone at 2556x1179 and a
 * tablet at 120 fps got the same as 720p. This follows the official Moonlight clients' table
 * (pixels at 30 fps, interpolated), then scales with the frame rate and the codec, and caps it
 * by where the PC is: on this network the Wi-Fi carries a lot; over the internet the limit is
 * the home connection's UPLOAD, usually far lower.
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 */

/// [pixels, kbps at 30 fps]: the official Moonlight clients' defaults
const TABLE: Array<[number, number]> = [
    [640 * 360, 1_000],
    [854 * 480, 2_000],
    [1280 * 720, 5_000],
    [1920 * 1080, 10_000],
    [2560 * 1440, 20_000],
    [3840 * 2160, 40_000],
]

/// HEVC and AV1 reach the same picture with about a quarter less than H.264
const EFFICIENT_CODEC_FACTOR = 0.75

const MIN_KBPS = 2_000
/// Same network: Wi-Fi 5/6 near the router carries this comfortably
const LOCAL_MAX_KBPS = 80_000
/// Over the internet: typical home upload
const INTERNET_MAX_KBPS = 20_000
/// Not known (no probe): in between
const UNKNOWN_MAX_KBPS = 40_000

export type AutoBitrate = { kbps: number, reason: string }

/// width x height at fps, with HEVC/AV1 possible (efficientCodec), on this network or not.
export function autoBitrateKbps(width: number, height: number, fps: number, efficientCodec: boolean, local: boolean | null): AutoBitrate {
    const pixels = Math.max(1, width * height)

    let kbps: number
    if (pixels <= TABLE[0][0]) {
        kbps = TABLE[0][1] * pixels / TABLE[0][0]
    } else if (pixels >= TABLE[TABLE.length - 1][0]) {
        const [p, k] = TABLE[TABLE.length - 1]
        kbps = k * pixels / p
    } else {
        let i = 1
        while (TABLE[i][0] < pixels) i++
        const [p0, k0] = TABLE[i - 1]
        const [p1, k1] = TABLE[i]
        kbps = k0 + (k1 - k0) * (pixels - p0) / (p1 - p0)
    }

    // Above 60 fps each frame changes less from the previous one: grows with the square root
    const fpsFactor = (fps <= 60 ? fps : Math.sqrt(fps / 60) * 60) / 30
    kbps *= fpsFactor
    if (efficientCodec) {
        kbps *= EFFICIENT_CODEC_FACTOR
    }

    const cap = local == null ? UNKNOWN_MAX_KBPS : local ? LOCAL_MAX_KBPS : INTERNET_MAX_KBPS
    const capped = kbps > cap
    kbps = Math.round(Math.min(Math.max(kbps, MIN_KBPS), cap) / 500) * 500

    const where = local == null ? "network unknown" : local ? "same network" : "over the internet"
    return {
        kbps,
        reason: `${width}x${height}@${fps}${efficientCodec ? " HEVC/AV1" : " H.264"}, ${where}${capped ? ", capped" : ""}`,
    }
}
