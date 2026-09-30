import { GetHostDisplayResponse } from "../api_bindings"
import { UpscalingRenderScale } from "../component/settings_menu"

/// Physical pixels of this device's screen, in landscape (streams are landscape).
/// CSS pixels × devicePixelRatio: an iPhone 15 Pro is 852×393 CSS but 2556×1179 physical.
export function physicalScreenSize(): [number, number] {
    const ratio = window.devicePixelRatio || 1
    const width = Math.round(window.screen.width * ratio)
    const height = Math.round(window.screen.height * ratio)

    return [Math.max(width, height), Math.min(width, height)]
}

/// Physical pixels of the screen without the sides covered by the notch/Dynamic Island and the
/// rounded corners, in landscape. Only the width shrinks (the notch side is removed from both
/// ends so the picture stays centered); the full height is kept — the home bar is only a thin
/// line over the picture.
export function safeAreaScreenSize(): [number, number] {
    const insets = safeAreaInsets()
    const ratio = window.devicePixelRatio || 1
    // Held upright (the stream is played sideways) the notch is on top
    const portrait = window.innerHeight > window.innerWidth

    const notchSide = portrait ? Math.max(insets.top, insets.bottom) : Math.max(insets.left, insets.right)

    const [width, height] = physicalScreenSize()
    return [Math.round(width - 2 * notchSide * ratio), height]
}

/// CSS pixels of the safe area insets (needs viewport-fit=cover, set in stream.html).
function safeAreaInsets(): { top: number, right: number, bottom: number, left: number } {
    const probe = document.createElement("div")
    probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;" +
        "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
    document.body.appendChild(probe)
    const style = getComputedStyle(probe)
    const insets = {
        top: parseFloat(style.paddingTop) || 0,
        right: parseFloat(style.paddingRight) || 0,
        bottom: parseFloat(style.paddingBottom) || 0,
        left: parseFloat(style.paddingLeft) || 0,
    }
    probe.remove()
    return insets
}

/// Encoders want even dimensions; round down so the request never exceeds the screen.
export function evenFloor(value: number): number {
    return Math.max(2, Math.floor(value / 2) * 2)
}

export type UpscalingDecision = {
    size: [number, number]
    reason: string
}

/// The virtual display can only switch to the resolutions its driver lists (a handful: too
/// many modes keep it from plugging in). Asking for anything else sends it to a generic mode,
/// with black bars when the shape differs. So a size wanted from this screen is replaced by the
/// listed mode with the closest shape and size (same measure as the Lightning Launcher's
/// remapping): any phone gets its screen's shape, and the picture is only scaled a little.
/// No list: the size is kept.
function closestVirtualMode(display: GetHostDisplayResponse, wanted: [number, number]): [number, number] {
    const modes = display.virtual_modes ?? []
    if (modes.length == 0) {
        return wanted
    }

    const aspect = wanted[0] / wanted[1]
    const area = wanted[0] * wanted[1]
    let best = modes[0]
    let bestScore = Infinity
    for (const mode of modes) {
        const score = Math.abs(mode.width / mode.height - aspect) + 0.3 * Math.abs(Math.log(mode.width * mode.height / area))
        if (score < bestScore) {
            bestScore = score
            best = mode
        }
    }
    return [best.width, best.height]
}

function virtualDisplayDecision(display: GetHostDisplayResponse, wanted: [number, number], what: string): UpscalingDecision {
    const [width, height] = closestVirtualMode(display, wanted)
    const snapped = width != wanted[0] || height != wanted[1]
    return {
        size: [evenFloor(width), evenFloor(height)],
        reason: `virtual display: ${what} ${wanted[0]}x${wanted[1]}` + (snapped ? `, closest mode ${width}x${height}` : ""),
    }
}

function physicalMonitorDecision(display: GetHostDisplayResponse): UpscalingDecision | null {
    if (display.primary_width && display.primary_height) {
        return {
            size: [evenFloor(display.primary_width), evenFloor(display.primary_height)],
            reason: "physical monitor: streaming at the monitor's resolution",
        }
    }
    return null
}

/// Resolution for the sizes taken from this screen, without upscaling (Lightning fork).
///
/// - Virtual display: the listed mode closest to `wanted` (this screen, or its safe area).
/// - Physical monitor: "auto" = the monitor's own resolution (its size and shape never
///   change, anything else would be scaled on the PC with black bars inside the video);
///   "full"/"safe" = null, keep what was asked.
/// - Unknown (remote host): null = keep what was asked.
export function deviceStreamerSize(
    display: GetHostDisplayResponse | null,
    choice: "auto" | "full" | "safe",
    wanted: [number, number],
): UpscalingDecision | null {
    if (!display || !display.local || display.virtual_display == null) {
        return null
    }

    if (!display.virtual_display) {
        return choice == "auto" ? physicalMonitorDecision(display) : null
    }

    return virtualDisplayDecision(display, wanted, choice == "safe" ? "safe area" : "this screen")
}

/// Resolution to ask the host for when upscaling is on (Lightning fork).
///
/// - Virtual display: the host renders less than this screen and it is upscaled here.
///   "auto" = half the screen, at least 720p; screens up to 1080p are not upscaled (a 4K TV
///   asks 1920×1080, an iPhone 15 Pro 1560×720). Then the closest listed mode.
/// - Physical monitor: its resolution is never changed; ask for the monitor's own resolution
///   and upscale from it.
/// - Unknown (host not on this machine, Sunshine config not set): null = keep the normal size.
export function upscalingStreamerSize(
    display: GetHostDisplayResponse | null,
    screen: [number, number],
    scale: UpscalingRenderScale,
): UpscalingDecision | null {
    if (!display || !display.local || display.virtual_display == null) {
        return null
    }

    if (!display.virtual_display) {
        return physicalMonitorDecision(display)
    }

    const [screenWidth, screenHeight] = screen
    const aspect = screenWidth / screenHeight

    let height
    if (scale == "auto") {
        if (screenHeight <= 1080) {
            return virtualDisplayDecision(display, screen, "screen up to 1080p, not upscaled:")
        }
        height = Math.max(720, Math.round(screenHeight / 2))
    } else {
        height = Math.max(480, Math.round(screenHeight * Number(scale) / 100))
    }

    return virtualDisplayDecision(display, [Math.round(height * aspect), height],
        scale == "auto" ? "half the screen" : scale + "% of the screen")
}

