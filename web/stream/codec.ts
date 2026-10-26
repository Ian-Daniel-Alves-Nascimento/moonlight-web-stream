/*
 * Lightning fork: the "Automatic" video codec.
 *
 * The host picks the best codec both ends support (AV1 > H.265 > H.264), so what matters is
 * what this device announces. Browsers announce codecs they can only decode in software
 * (Chrome announces AV1 everywhere): streaming those heats the phone, drains the battery and
 * drops frames. So a codec above H.264 is only announced when this device decodes it in
 * hardware, and one that already failed to show a picture here is left out.
 *
 * 10 bits without HDR: an 8 bit stream turns skies, shadows and fog into bands and blocks.
 * Sunshine encodes 10 bits in plain SDR when the client offers a 10 bit format (it only turns
 * HDR on when the PC's display is in HDR too), at the same bitrate. So "auto" also offers the
 * 10 bit profile when this device decodes it in hardware. If the PC's display turns out to be
 * in HDR (the stream would come in HDR, washed out on a phone that shows it as SDR), the
 * stream restarts in 8 bits and 10 bits stay off here for a while (see avoidTenBitSdr).
 */

import { VideoFormats } from "../uniffi/moonlight_common_bindings"
import { emptyVideoCodecs } from "./video"

export type CodecFamily = "h264" | "h265" | "av1"

const AVOID_STORAGE_KEY = "ltCodecAvoid"
const TEN_BIT_SDR_AVOID_KEY = "ltTenBitSdrAvoidUntil"
/// How long 10 bit SDR stays off after the PC's display was found in HDR (it may go back to SDR)
const TEN_BIT_SDR_AVOID_MS = 6 * 60 * 60 * 1000
/// ...and after a 10 bit stream showed no picture on this device (a fact about the device)
const TEN_BIT_SDR_BROKEN_MS = 30 * 24 * 60 * 60 * 1000

/// Formats to announce for the "auto" codec setting.
export async function autoVideoCodecs(hdr: boolean): Promise<{ formats: VideoFormats, reason: string }> {
    const formats = emptyVideoCodecs()
    formats.h264 = true

    const receivable = receivableCodecs()
    const avoided = avoidedCodecs()
    const notes: Array<string> = []
    const tenBitSdr = !hdr && !tenBitSdrAvoided()

    for (const family of ["h265", "av1"] as const) {
        if (!receivable.has(family)) {
            notes.push(`${family}: not offered by this browser`)
            continue
        }
        if (avoided.includes(family)) {
            notes.push(`${family}: showed no picture here before`)
            continue
        }

        const hardware = await decodesInHardware(family)
        if (!hardware) {
            notes.push(`${family}: software decoding only`)
            continue
        }

        const tenBit = hdr || (tenBitSdr && await decodesTenBitInHardware(family))
        notes.push(`${family}: hardware${!hdr && tenBit ? ", 10 bit" : ""}`)
        if (family == "h265") {
            formats.h265 = true
            formats.h265Main10 = tenBit
        } else {
            formats.av1Main8 = true
            formats.av1Main10 = tenBit
        }
    }

    return { formats, reason: notes.join(", ") }
}

/// Codecs this browser can receive over WebRTC.
function receivableCodecs(): Set<CodecFamily> {
    const families = new Set<CodecFamily>()
    const codecs = typeof RTCRtpReceiver != "undefined" && RTCRtpReceiver.getCapabilities
        ? RTCRtpReceiver.getCapabilities("video")?.codecs ?? []
        : []

    for (const codec of codecs) {
        const mime = codec.mimeType.toLowerCase()
        if (mime == "video/h264") {
            families.add("h264")
        } else if (mime == "video/h265" || mime == "video/hevc") {
            families.add("h265")
        } else if (mime == "video/av1") {
            families.add("av1")
        }
    }
    return families
}

/// Whether the device decodes this codec in hardware, asked through Media Capabilities for a
/// 1080p60 WebRTC stream ("powerEfficient" is the browser's word for a hardware decoder).
/// Without that API: H.265 counts as hardware (browsers only offer it over WebRTC with a
/// hardware decoder), AV1 doesn't (software decoders are common).
async function decodesInHardware(family: "h265" | "av1"): Promise<boolean> {
    const mime = family == "h265" ? "video/H265" : "video/AV1"
    try {
        const info = await navigator.mediaCapabilities.decodingInfo({
            type: "webrtc",
            video: {
                contentType: mime,
                width: 1920,
                height: 1080,
                bitrate: 10_000_000,
                framerate: 60,
            },
        } as MediaDecodingConfiguration)
        return info.supported && info.powerEfficient
    } catch {
        return family == "h265"
    }
}

/// Whether the device decodes the 10 bit profile in hardware (HEVC Main10, AV1 Main 10 bit at
/// 1080p60). The WebRTC query can't name a bit depth, so this asks for the same stream as a
/// file; the hardware decoder is the same one.
async function decodesTenBitInHardware(family: "h265" | "av1"): Promise<boolean> {
    const contentType = family == "h265" ? 'video/mp4; codecs="hvc1.2.4.L123.B0"' : 'video/mp4; codecs="av01.0.08M.10"'
    try {
        const info = await navigator.mediaCapabilities.decodingInfo({
            type: "media-source",
            video: { contentType, width: 1920, height: 1080, bitrate: 10_000_000, framerate: 60 },
        })
        return info.supported && info.powerEfficient
    } catch {
        return false
    }
}

/// Whether a negotiated format is 10 bit.
export function isTenBit(format: keyof VideoFormats): boolean {
    return format.includes("10")
}

function tenBitSdrAvoided(): boolean {
    try {
        return Date.now() < Number(localStorage.getItem(TEN_BIT_SDR_AVOID_KEY) ?? "0")
    } catch {
        return false
    }
}

/// 10 bit SDR stays off here for a while: "hdr" when the PC's display is in HDR (a 10 bit stream
/// would come in HDR; checked again later), "noPicture" when a 10 bit stream showed nothing here
/// (the decoder takes it but the browser's WebRTC path doesn't: the codec itself stays, in 8 bits).
export function avoidTenBitSdr(reason: "hdr" | "noPicture") {
    try {
        localStorage.setItem(TEN_BIT_SDR_AVOID_KEY, String(Date.now() + (reason == "hdr" ? TEN_BIT_SDR_AVOID_MS : TEN_BIT_SDR_BROKEN_MS)))
    } catch {
        // Storage unavailable: the next stream tries 10 bits again
    }
}

/// Which family a negotiated format belongs to.
export function codecFamily(format: keyof VideoFormats): CodecFamily {
    return format.startsWith("h265") ? "h265" : format.startsWith("av1") ? "av1" : "h264"
}

export function codecDisplayName(family: CodecFamily): string {
    return family == "h265" ? "H.265" : family == "av1" ? "AV1" : "H.264"
}

function avoidedCodecs(): Array<CodecFamily> {
    try {
        const stored = JSON.parse(localStorage.getItem(AVOID_STORAGE_KEY) ?? "[]")
        return Array.isArray(stored) ? stored : []
    } catch {
        return []
    }
}

/// Remembers on this device that a codec showed no picture, so "auto" stops announcing it.
export function avoidCodec(family: CodecFamily) {
    try {
        const avoided = avoidedCodecs()
        if (!avoided.includes(family)) {
            avoided.push(family)
        }
        localStorage.setItem(AVOID_STORAGE_KEY, JSON.stringify(avoided))
    } catch {
        // Storage unavailable: nothing to remember
    }
}
