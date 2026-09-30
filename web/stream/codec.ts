/*
 * Lightning fork: the "Automatic" video codec.
 *
 * The host picks the best codec both ends support (AV1 > H.265 > H.264), so what matters is
 * what this device announces. Browsers announce codecs they can only decode in software
 * (Chrome announces AV1 everywhere): streaming those heats the phone, drains the battery and
 * drops frames. So a codec above H.264 is only announced when this device decodes it in
 * hardware, and one that already failed to show a picture here is left out.
 */

import { VideoFormats } from "../uniffi/moonlight_common_bindings"
import { emptyVideoCodecs } from "./video"

export type CodecFamily = "h264" | "h265" | "av1"

const AVOID_STORAGE_KEY = "ltCodecAvoid"

/// Formats to announce for the "auto" codec setting.
export async function autoVideoCodecs(hdr: boolean): Promise<{ formats: VideoFormats, reason: string }> {
    const formats = emptyVideoCodecs()
    formats.h264 = true

    const receivable = receivableCodecs()
    const avoided = avoidedCodecs()
    const notes: Array<string> = []

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

        notes.push(`${family}: hardware`)
        if (family == "h265") {
            formats.h265 = true
            formats.h265Main10 = hdr
        } else {
            formats.av1Main8 = true
            formats.av1Main10 = hdr
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
