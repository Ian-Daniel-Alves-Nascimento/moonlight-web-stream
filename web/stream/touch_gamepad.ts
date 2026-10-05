// Lightning touch gamepad: an on-screen Xbox controller for phones and tablets.
//
// Copyright (c) 2026 the author of Lightning Launcher (github.com/Ian-Daniel-Alves-Nascimento).
// Part of this fork under GPL-3.0-or-later. The file is self-contained on purpose (no imports):
// its author also uses it, under other terms, in Lightning Companion.
//
// A glass screen has no stick centre to feel, no trigger travel and no button edges, so the
// design leans on what a screen CAN do (sources: Xbox Cloud Gaming touch adaptation guidance,
// the floating-joystick findings of Baldauf et al. 2015, the virtual-joystick tactile study and
// the usual mobile tuning practice):
//   - floating sticks: the stick is born where the thumb lands and its base follows a thumb
//     that overshoots, so there is no centre to find and no edge to fall off;
//   - small radial dead zone + "anti dead zone": the first millimetres already move the game
//     (games ignore roughly the first quarter of a real stick);
//   - buttons larger to the touch than to the eye, rolling from one face button to the next
//     like on a real pad, and two at once when the thumb lands between them;
//   - a tick on every press and when the stick reaches its rim (vibration on Android; the
//     Taptic Engine through the switch-control trick on iOS 17.4 to 26.4);
//   - the camera as a touchpad (drag to look) and a fire button that also aims;
//   - layouts per genre: standard, action, retro (floating 8-way D-pad) and racing (analog
//     pedals set by how high the thumb sits).
//
// Output follows XInput: sticks -1..1 with Y UP positive, triggers 0..1, buttons as XUSB bits.

export const PAD = {
    UP: 0x0001, DOWN: 0x0002, LEFT: 0x0004, RIGHT: 0x0008,
    START: 0x0010, BACK: 0x0020, LS: 0x0040, RS: 0x0080,
    LB: 0x0100, RB: 0x0200, GUIDE: 0x0400,
    A: 0x1000, B: 0x2000, X: 0x4000, Y: 0x8000,
} as const

export type TouchGamepadLayout = "standard" | "action" | "retro" | "racing"
export type TouchGamepadLook = "stick" | "touchpad"

export type TouchGamepadExtraButton = {
    id: string
    label: string
    svg: string
    side: "left" | "right"
}

export type TouchGamepadOptions = {
    layout: TouchGamepadLayout
    /// 0.8 .. 1.3
    size: number
    /// 0.2 .. 1 (how visible the controls are while idle)
    opacity: number
    haptics: boolean
    /// Right side of the standard layout: a floating stick or drag-to-look
    look: TouchGamepadLook
    /// 0.5 .. 2
    lookSensitivity: number
    /// Holding the left stick at its rim clicks L3 once (sprint in most games)
    sprintAtEdge: boolean
    /// Drawn sideways on an upright phone (iOS can't lock the orientation of a page)
    rotation: 0 | 90 | -90
    extraButtons: Array<TouchGamepadExtraButton>
    texts: { brake: string, gas: string, show: string }
}

export type TouchGamepadState = {
    buttons: number
    lt: number
    rt: number
    lx: number
    ly: number
    rx: number
    ry: number
}

export type TouchGamepadEvents = {
    onState: (state: TouchGamepadState) => void
    /// Every touch on the pad. Browsers count the END of a touch ("up") as the user gesture
    /// that may unmute audio or enter fullscreen; "down" comes first, for anything else.
    onInteraction?: (phase: "down" | "up") => void
    onExtra?: (id: string) => void
    /// The pad was collapsed into its small button, or brought back
    onCollapse?: (collapsed: boolean) => void
}

export function defaultTouchGamepadOptions(): TouchGamepadOptions {
    return {
        layout: "standard",
        size: 1,
        opacity: 0.6,
        haptics: true,
        look: "stick",
        lookSensitivity: 1,
        sprintAtEdge: false,
        rotation: 0,
        extraButtons: [],
        texts: { brake: "BRAKE", gas: "GAS", show: "Show the on-screen controller" },
    }
}

export function emptyTouchGamepadState(): TouchGamepadState {
    return { buttons: 0, lt: 0, rt: 0, lx: 0, ly: 0, rx: 0, ry: 0 }
}

// -- Tuning
const STICK_DEAD_ZONE = 0.1
// Where the output starts once past the dead zone: games ignore about the first quarter of a
// real stick, so a small thumb move must already land beyond that
const STICK_ANTI_DEAD_ZONE = 0.2
const STICK_CURVE = 1.15
const RIM_ON = 0.98
const RIM_OFF = 0.85
const SPRINT_HOLD_MS = 350
const DOUBLE_TAP_GAP_MS = 280
const DOUBLE_TAP_FIRST_MAX_MS = 220
const PULSE_MS = 90
// Drag to look: this many px per 60 Hz frame is a full deflection at sensitivity 1
const LOOK_FULL_PX_PER_FRAME = 11
const LOOK_ANTI_DEAD_ZONE = 0.18
const LOOK_MIN_PX_PER_FRAME = 0.25
const LOOK_SMOOTHING = 0.55
const LOOK_HOLD_MS = 34

type Box = { x: number, y: number, w: number, h: number }

type ButtonCtl = {
    kind: "button"
    id: string
    label: string
    svg?: string
    bit: number
    trigger?: "lt" | "rt"
    /// Pedal: the value follows how high the thumb sits on it
    analog?: boolean
    /// Dragging this button also moves the camera (fire-and-aim)
    look?: boolean
    extra?: string
    group: "face" | "other"
    shape: "circle" | "pill" | "pedal"
    x: number
    y: number
    w: number
    h: number
    slop: number
    tone?: string
    el?: HTMLElement
    fill?: HTMLElement
    value: number
}

type StickCtl = {
    kind: "stick"
    side: "left" | "right"
    home: { x: number, y: number }
    r: number
    zone: Box
    horizontal: boolean
    base?: HTMLElement
    knob?: HTMLElement
}

type DpadCtl = {
    kind: "dpad"
    x: number
    y: number
    r: number
    floating: boolean
    zone?: Box
    el?: HTMLElement
}

type LookCtl = { kind: "look", zone: Box }

type Finger = {
    id: number
    kind: "face" | "button" | "stick" | "dpad" | "look" | "none"
    start: number
    pressed: Set<ButtonCtl>
    button?: ButtonCtl
    stick?: StickCtl
    dpad?: DpadCtl
    cx: number
    cy: number
    x: number
    y: number
    rim: boolean
    rimSince: number
    sprinted: boolean
    dir: number
    value: number
}

type StickMemory = { lastEnd: number, lastDuration: number }

const SVG_VIEW = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="3" y="7" width="12" height="10" rx="2"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4H19a2 2 0 0 1 2 2v7.5a1.5 1.5 0 0 1-1.5 1.5H15"/></svg>`
const SVG_MENU = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 7h14M5 12h14M5 17h14"/></svg>`
const SVG_HOME = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/></svg>`
const SVG_PAD = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7.5 7h9a5 5 0 0 1 4.8 6.4l-1 3.6a2.6 2.6 0 0 1-4.4 1.1L13.6 16h-3.2l-2.3 2.1a2.6 2.6 0 0 1-4.4-1.1l-1-3.6A5 5 0 0 1 7.5 7z"/><path d="M8 10.5v3M6.5 12h3"/><circle cx="16" cy="11" r=".6" fill="currentColor"/><circle cx="17.5" cy="13" r=".6" fill="currentColor"/></svg>`

const SVG_DPAD = `<svg viewBox="0 0 100 100"><path class="x" d="M37 3h26a5 5 0 0 1 5 5v24h24a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H68v24a5 5 0 0 1-5 5H37a5 5 0 0 1-5-5V68H8a5 5 0 0 1-5-5V37a5 5 0 0 1 5-5h24V8a5 5 0 0 1 5-5z"/>`
    + `<path class="arm u" d="M32 32V8a5 5 0 0 1 5-5h26a5 5 0 0 1 5 5v24L50 50z"/><path class="arm d" d="M32 68v24a5 5 0 0 0 5 5h26a5 5 0 0 0 5-5V68L50 50z"/>`
    + `<path class="arm l" d="M32 32H8a5 5 0 0 0-5 5v26a5 5 0 0 0 5 5h24L50 50z"/><path class="arm r" d="M68 32h24a5 5 0 0 1 5 5v26a5 5 0 0 1-5 5H68L50 50z"/>`
    + `<path class="ar" d="M50 11l-7 9h14zM50 89l-7-9h14zM11 50l9-7v14zM89 50l-9-7v14z"/></svg>`

const STYLE_ID = "ltpad-style"
const STYLE = `
.ltpad{position:fixed;left:0;top:0;width:100%;height:100%;z-index:15;pointer-events:none;
  --a:.6;--u:1;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#fff;
  -webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent}
.ltpad[hidden]{display:none}
.ltpad-surface{position:absolute;pointer-events:auto;touch-action:none}
.ltpad-collapsed .ltpad-surface{display:none}
.ltpad-c{position:absolute;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
  opacity:var(--a);transition:opacity .14s ease,transform .09s ease,background-color .14s ease,box-shadow .14s ease;
  pointer-events:none}
.ltpad-btn{border-radius:999px;background:rgba(16,18,26,.38);border:calc(var(--u)*1.6px) solid rgba(255,255,255,.62);
  font-weight:800;letter-spacing:.02em;box-shadow:0 2px 10px rgba(0,0,0,.28)}
.ltpad-btn svg{width:56%;height:56%}
.ltpad-btn.on{opacity:1;transform:scale(.9);background:rgba(255,255,255,.3);box-shadow:0 0 0 calc(var(--u)*5px) rgba(255,255,255,.14)}
.ltpad-face{font-size:calc(var(--u)*21px)}
.ltpad-face b{font-weight:800}
.ltpad-pill{font-size:calc(var(--u)*13px)}
.ltpad-sys{opacity:calc(var(--a)*.9)}
.ltpad-sys svg{width:58%;height:58%}
.ltpad-pedal{border-radius:calc(var(--u)*18px);overflow:hidden;flex-direction:column;justify-content:flex-end;
  font-size:calc(var(--u)*13px)}
.ltpad-pedal .ltpad-fill{position:absolute;left:0;right:0;bottom:0;height:0;background:rgba(255,255,255,.34)}
.ltpad-pedal span{position:relative;margin-bottom:calc(var(--u)*10px);text-align:center;line-height:1.15}
.ltpad-pedal small{display:block;font-size:.8em;opacity:.8;font-weight:600}
.ltpad-big{font-size:calc(var(--u)*17px)}
.ltpad-stick{border-radius:999px;border:calc(var(--u)*1.6px) solid rgba(255,255,255,.5);background:rgba(16,18,26,.24);
  opacity:calc(var(--a)*.55);transition:opacity .16s ease}
.ltpad-stick.h{border-radius:calc(var(--u)*30px)}
.ltpad-stick.on{opacity:calc(.35 + var(--a)*.6);transition:none}
.ltpad-stick.rim{box-shadow:0 0 0 calc(var(--u)*3px) rgba(255,255,255,.35)}
.ltpad-knob{position:absolute;left:50%;top:50%;border-radius:999px;background:rgba(255,255,255,.55);
  box-shadow:0 2px 8px rgba(0,0,0,.35);transform:translate(-50%,-50%)}
.ltpad-stick-tag{position:absolute;font-size:calc(var(--u)*11px);font-weight:700;opacity:.75;bottom:calc(var(--u)*-18px)}
.ltpad-dpad{opacity:var(--a)}
.ltpad-dpad.float{opacity:calc(var(--a)*.55)}
.ltpad-dpad.on{opacity:1}
.ltpad-dpad svg{width:100%;height:100%;overflow:visible;filter:drop-shadow(0 2px 6px rgba(0,0,0,.3))}
.ltpad-dpad .x{fill:rgba(16,18,26,.38);stroke:rgba(255,255,255,.62);stroke-width:calc(var(--u)*1.6px);vector-effect:non-scaling-stroke}
.ltpad-dpad .arm{fill:transparent;transition:fill .1s ease}
.ltpad-dpad .arm.on{fill:rgba(255,255,255,.42)}
.ltpad-dpad .ar{fill:rgba(255,255,255,.6)}
.ltpad-chip{position:absolute;pointer-events:auto;touch-action:none;display:none;align-items:center;justify-content:center;
  width:calc(var(--u)*44px);height:calc(var(--u)*44px);border-radius:999px;background:rgba(16,18,26,.5);
  border:calc(var(--u)*1.6px) solid rgba(255,255,255,.6);opacity:.7;color:#fff;padding:0;box-sizing:border-box;cursor:pointer}
.ltpad-chip svg{width:60%;height:60%}
.ltpad-collapsed .ltpad-chip{display:flex}
@media (prefers-reduced-motion: reduce){.ltpad-c,.ltpad-stick{transition:none}}
`

/// Short haptic ticks. Android: the Vibration API. iOS has none for pages, but toggling an
/// <input type="checkbox" switch> plays the system tick (Safari 17.4 to iOS 26.4; Apple closed
/// it in 26.5, where this silently does nothing).
class Haptics {
    private label: HTMLLabelElement | null = null
    private readonly canVibrate = typeof navigator.vibrate == "function"
    private rumbleUntil = 0

    constructor() {
        const ios = /iP(hone|ad|od)/.test(navigator.userAgent)
            || (navigator.userAgent.includes("Macintosh") && "ontouchend" in document)
        if (!this.canVibrate && ios) {
            const label = document.createElement("label")
            const input = document.createElement("input")
            input.type = "checkbox"
            input.setAttribute("switch", "")
            input.tabIndex = -1
            label.setAttribute("aria-hidden", "true")
            label.style.cssText = "position:fixed;left:-200px;top:0;width:1px;height:1px;opacity:0;overflow:hidden;pointer-events:none"
            label.appendChild(input)
            // The click must not reach the page's own listeners
            label.addEventListener("click", event => event.stopPropagation())
            input.addEventListener("click", event => event.stopPropagation())
            document.body.appendChild(label)
            this.label = label
        }
    }

    supported(): boolean {
        return this.canVibrate || this.label != null
    }
    canRumble(): boolean {
        return this.canVibrate
    }

    tick(strong = false) {
        // A game rumble is playing: a tick would cut it short
        if (performance.now() < this.rumbleUntil) {
            return
        }
        try {
            if (this.canVibrate) {
                navigator.vibrate(strong ? 16 : 8)
            } else {
                this.label?.click()
            }
        } catch {
            // Not allowed right now: no tick
        }
    }

    /// Game rumble, 0..1. A phone motor is on/off: the strength becomes how long it stays on
    /// in each 60 ms slice. Call again before the slice ends to keep it going.
    rumble(level: number) {
        if (!this.canVibrate) {
            return
        }
        try {
            if (level < 0.06) {
                if (this.rumbleUntil > 0) {
                    navigator.vibrate(0)
                    this.rumbleUntil = 0
                }
                return
            }
            const on = Math.round(14 + 46 * Math.min(1, level))
            navigator.vibrate(on)
            this.rumbleUntil = performance.now() + 70
        } catch {
            // ignore
        }
    }

    destroy() {
        this.label?.remove()
        this.label = null
    }
}

function element(tag: string, className: string, parent?: HTMLElement): HTMLElement {
    const el = document.createElement(tag)
    el.className = className
    parent?.appendChild(el)
    return el
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
}

function inBox(box: Box, x: number, y: number): boolean {
    return x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h
}

export class TouchGamepad {
    private options: TouchGamepadOptions
    private events: TouchGamepadEvents

    private root: HTMLElement
    private surface: HTMLElement
    private chip: HTMLElement
    private haptics = new Haptics()

    private width = 0
    private height = 0
    private unit = 1
    private area: Box = { x: 0, y: 0, w: 0, h: 0 }

    private buttons: Array<ButtonCtl> = []
    private sticks: Array<StickCtl> = []
    private dpads: Array<DpadCtl> = []
    private looks: Array<LookCtl> = []

    private fingers = new Map<number, Finger>()
    private stickMemory: Record<"left" | "right", StickMemory> = {
        left: { lastEnd: 0, lastDuration: 0 },
        right: { lastEnd: 0, lastDuration: 0 },
    }
    private pulses = new Map<number, number>()

    private lookAccX = 0
    private lookAccY = 0
    private lookLastMove = 0
    private lookX = 0
    private lookY = 0
    private lookTargetX = 0
    private lookTargetY = 0
    private lastFrame = 0
    private frameRequested = false

    private lastState = emptyTouchGamepadState()
    private visible = true
    private collapsed = false
    private destroyed = false

    private layoutKey = ""
    private onResize = () => this.layout(false)
    private onBlur = () => this.releaseAll()

    constructor(parent: HTMLElement, events: TouchGamepadEvents, options?: Partial<TouchGamepadOptions>) {
        this.events = events
        this.options = { ...defaultTouchGamepadOptions(), ...options }

        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement("style")
            style.id = STYLE_ID
            style.textContent = STYLE
            document.head.appendChild(style)
        }

        this.root = element("div", "ltpad", parent)
        this.surface = element("div", "ltpad-surface", this.root)
        // A div, not a <button>: pages style every button (the player's hover lift, min-height...)
        this.chip = element("div", "ltpad-chip", this.root)
        this.chip.setAttribute("role", "button")
        this.chip.innerHTML = SVG_PAD

        const surface = this.surface
        surface.addEventListener("pointerdown", this.onPointerDown.bind(this))
        surface.addEventListener("pointermove", this.onPointerMove.bind(this))
        surface.addEventListener("pointerup", this.onPointerUp.bind(this))
        surface.addEventListener("pointercancel", this.onPointerUp.bind(this))
        surface.addEventListener("lostpointercapture", this.onPointerUp.bind(this))
        // The page under the pad (the stream's own touch/mouse handling) must not see these
        for (const type of ["touchstart", "touchmove", "touchend", "touchcancel"]) {
            surface.addEventListener(type, event => {
                event.stopPropagation()
                if (event.cancelable) event.preventDefault()
            }, { passive: false })
        }
        for (const type of ["mousedown", "mouseup", "mousemove", "click", "dblclick", "contextmenu", "wheel"]) {
            surface.addEventListener(type, event => {
                event.stopPropagation()
                if (event.cancelable) event.preventDefault()
            }, { passive: false })
        }

        for (const type of ["touchstart", "touchend", "mousedown", "mouseup", "click"]) {
            this.chip.addEventListener(type, event => event.stopPropagation(), { passive: true })
        }
        this.chip.addEventListener("click", () => {
            this.events.onInteraction?.("up")
            this.setCollapsed(false)
        })

        window.addEventListener("resize", this.onResize)
        window.addEventListener("orientationchange", this.onResize)
        window.visualViewport?.addEventListener("resize", this.onResize)
        window.addEventListener("blur", this.onBlur)
        document.addEventListener("visibilitychange", this.onBlur)

        this.layout(true)
    }

    // -- Public API
    getOptions(): TouchGamepadOptions {
        return { ...this.options, extraButtons: [...this.options.extraButtons] }
    }
    setOptions(options: Partial<TouchGamepadOptions>) {
        Object.assign(this.options, options)
        this.layout(true)
    }
    setVisible(visible: boolean) {
        if (this.visible == visible) {
            return
        }
        this.visible = visible
        this.root.hidden = !visible
        if (!visible) {
            this.releaseAll()
        }
    }
    isVisible(): boolean {
        return this.visible
    }
    setCollapsed(collapsed: boolean) {
        if (this.collapsed == collapsed) {
            return
        }
        this.collapsed = collapsed
        this.root.classList.toggle("ltpad-collapsed", collapsed)
        if (collapsed) {
            this.releaseAll()
        }
        this.events.onCollapse?.(collapsed)
    }
    isCollapsed(): boolean {
        return this.collapsed
    }
    hapticsSupported(): boolean {
        return this.haptics.supported()
    }
    canRumble(): boolean {
        return this.haptics.canRumble()
    }
    /// Game rumble (0..1), for the pad's own player. Android only.
    rumble(level: number) {
        if (this.options.haptics && this.visible && !this.collapsed) {
            this.haptics.rumble(level)
        } else {
            this.haptics.rumble(0)
        }
    }
    getState(): TouchGamepadState {
        return { ...this.lastState }
    }
    /// Lets go of everything (and tells the game): leaving the page, hiding, rotating...
    releaseAll() {
        for (const finger of this.fingers.values()) {
            try {
                this.surface.releasePointerCapture(finger.id)
            } catch {
                // not captured
            }
        }
        this.fingers.clear()
        this.pulses.clear()
        this.lookAccX = this.lookAccY = 0
        this.lookX = this.lookY = this.lookTargetX = this.lookTargetY = 0
        for (const button of this.buttons) {
            button.value = 0
        }
        this.render()
        this.emit()
    }
    destroy() {
        if (this.destroyed) {
            return
        }
        this.releaseAll()
        this.destroyed = true
        window.removeEventListener("resize", this.onResize)
        window.removeEventListener("orientationchange", this.onResize)
        window.visualViewport?.removeEventListener("resize", this.onResize)
        window.removeEventListener("blur", this.onBlur)
        document.removeEventListener("visibilitychange", this.onBlur)
        this.haptics.destroy()
        this.root.remove()
    }

    // -- Geometry
    private safeInsets(): { top: number, right: number, bottom: number, left: number } {
        const probe = element("div", "", document.body)
        probe.style.cssText = "position:fixed;left:0;top:0;visibility:hidden;pointer-events:none;" +
            "padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"
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

    /// Screen (client) coordinates -> the pad's own landscape coordinates
    private toLocal(clientX: number, clientY: number): [number, number] {
        const rotation = this.options.rotation
        if (rotation == 90) {
            return [clientY - this.area.x, window.innerWidth - clientX - this.area.y]
        } else if (rotation == -90) {
            return [window.innerHeight - clientY - this.area.x, clientX - this.area.y]
        }
        return [clientX - this.area.x, clientY - this.area.y]
    }

    private layout(force: boolean) {
        if (this.destroyed) {
            return
        }
        // iOS fires resizes for little things (toolbars, the keyboard): redoing the layout
        // lets go of every button, so only when the screen really changed
        const key = `${window.innerWidth}x${window.innerHeight}`
        if (!force && key == this.layoutKey) {
            return
        }
        this.layoutKey = key
        this.chip.setAttribute("aria-label", this.options.texts.show)
        this.chip.title = this.options.texts.show
        this.releaseAll()

        const rotation = this.options.rotation
        const screenWidth = window.innerWidth
        const screenHeight = window.innerHeight
        const rootStyle = this.root.style
        const screenInsets = this.safeInsets()
        let insets = screenInsets
        if (rotation == 90) {
            this.width = screenHeight
            this.height = screenWidth
            rootStyle.width = `${screenHeight}px`
            rootStyle.height = `${screenWidth}px`
            rootStyle.transformOrigin = "0 0"
            rootStyle.transform = "rotate(90deg) translateY(-100%)"
            insets = { left: screenInsets.top, right: screenInsets.bottom, top: screenInsets.right, bottom: screenInsets.left }
        } else if (rotation == -90) {
            this.width = screenHeight
            this.height = screenWidth
            rootStyle.width = `${screenHeight}px`
            rootStyle.height = `${screenWidth}px`
            rootStyle.transformOrigin = "0 0"
            rootStyle.transform = "rotate(-90deg) translateX(-100%)"
            insets = { left: screenInsets.bottom, right: screenInsets.top, top: screenInsets.left, bottom: screenInsets.right }
        } else {
            this.width = screenWidth
            this.height = screenHeight
            rootStyle.width = ""
            rootStyle.height = ""
            rootStyle.transform = ""
        }

        // Upright without rotation: the pad takes the lower half, the picture stays above
        if (rotation == 0 && this.height > this.width) {
            const h = Math.round(this.height * 0.5)
            this.area = { x: 0, y: this.height - h, w: this.width, h }
            insets = { ...insets, top: 0 }
        } else {
            this.area = { x: 0, y: 0, w: this.width, h: this.height }
        }

        const W = this.area.w
        const H = this.area.h
        // Sized in CSS pixels (about the same physical size on phones and tablets), shrunk on
        // short screens so everything still fits
        const u = clamp(Math.min(H / 380, W / 760), 0.72, 1.15) * clamp(this.options.size, 0.6, 1.5)
        this.unit = u

        rootStyle.setProperty("--a", String(clamp(this.options.opacity, 0.15, 1)))
        rootStyle.setProperty("--u", String(u))
        Object.assign(this.surface.style, {
            left: `${this.area.x}px`, top: `${this.area.y}px`, width: `${W}px`, height: `${H}px`,
        })

        const L = insets.left + 14 * u
        const R = W - insets.right - 14 * u
        const T = insets.top + 10 * u
        const B = H - insets.bottom - 12 * u

        this.buttons = []
        this.sticks = []
        this.dpads = []
        this.looks = []

        const layout = this.options.layout
        const leftZone: Box = { x: 0, y: T + 54 * u, w: W * 0.47, h: H }
        const rightZone: Box = { x: W * 0.53, y: T + 54 * u, w: W * 0.47, h: H }

        // System row: View, Guide, Menu in the middle, host buttons on either side
        const rowY = T + 19 * u
        const mid = W / 2
        this.addButton({ id: "back", label: "", svg: SVG_VIEW, bit: PAD.BACK, shape: "pill", x: mid - 52 * u, y: rowY, w: 46 * u, h: 32 * u, slop: 8 * u, group: "other" }, "ltpad-sys")
        this.addButton({ id: "guide", label: "", svg: SVG_HOME, bit: PAD.GUIDE, shape: "circle", x: mid, y: rowY, w: 34 * u, h: 34 * u, slop: 6 * u, group: "other" }, "ltpad-sys")
        this.addButton({ id: "start", label: "", svg: SVG_MENU, bit: PAD.START, shape: "pill", x: mid + 52 * u, y: rowY, w: 46 * u, h: 32 * u, slop: 8 * u, group: "other" }, "ltpad-sys")
        let leftX = mid - 52 * u - 23 * u - 30 * u
        let rightX = mid + 52 * u + 23 * u + 30 * u
        for (const extra of this.options.extraButtons) {
            const x = extra.side == "left" ? leftX : rightX
            if (extra.side == "left") leftX -= 46 * u
            else rightX += 46 * u
            this.addButton({ id: "extra-" + extra.id, label: "", svg: extra.svg, bit: 0, extra: extra.id, shape: "circle", x, y: rowY, w: 36 * u, h: 36 * u, slop: 5 * u, group: "other" }, "ltpad-sys")
        }

        // Shoulders: bumpers and triggers in the top corners (pedals replace triggers when racing)
        const shoulder = (side: "left" | "right", withTrigger: boolean) => {
            const sign = side == "left" ? 1 : -1
            const edge = side == "left" ? L : R
            if (withTrigger) {
                this.addButton({ id: side == "left" ? "lt" : "rt", label: side == "left" ? "LT" : "RT", bit: 0, trigger: side == "left" ? "lt" : "rt", shape: "pill", x: edge + sign * 43 * u, y: T + 22 * u, w: 86 * u, h: 44 * u, slop: 10 * u, group: "other" }, "ltpad-pill")
            }
            const bx = withTrigger ? edge + sign * (96 + 37) * u : edge + sign * 43 * u
            this.addButton({ id: side == "left" ? "lb" : "rb", label: side == "left" ? "LB" : "RB", bit: side == "left" ? PAD.LB : PAD.RB, shape: "pill", x: bx, y: T + 22 * u, w: 74 * u, h: 38 * u, slop: 10 * u, group: "other" }, "ltpad-pill")
        }

        const face = (cx: number, cy: number, spacing: number, radius: number) => {
            const defs: Array<[string, number, number, number, string]> = [
                ["a", PAD.A, 0, 1, "#7ed957"],
                ["b", PAD.B, 1, 0, "#ff6b5e"],
                ["x", PAD.X, -1, 0, "#5aa9ff"],
                ["y", PAD.Y, 0, -1, "#ffd84a"],
            ]
            for (const [id, bit, dx, dy, tone] of defs) {
                this.addButton({ id, label: id.toUpperCase(), bit, shape: "circle", x: cx + dx * spacing, y: cy + dy * spacing, w: radius * 2, h: radius * 2, slop: radius * 0.38, group: "face", tone }, "ltpad-face")
            }
        }

        if (layout == "racing") {
            shoulder("left", false)
            shoulder("right", false)
            const gas: ButtonCtl = this.addButton({ id: "rt", label: "RT", bit: 0, trigger: "rt", analog: true, shape: "pedal", x: R - 40 * u, y: B - 78 * u, w: 80 * u, h: 156 * u, slop: 8 * u, group: "other" }, "ltpad-big")
            this.addButton({ id: "lt", label: "LT", bit: 0, trigger: "lt", analog: true, shape: "pedal", x: R - 80 * u - 14 * u - 40 * u, y: B - 64 * u, w: 80 * u, h: 128 * u, slop: 8 * u, group: "other" }, "ltpad-big")
            const top = gas.y - gas.h / 2
            const spacing = 40 * u
            const faceY = Math.min(T + 112 * u, top - spacing - 30 * u)
            face(R - 64 * u, faceY, spacing, 21 * u)
            this.dpads.push({ kind: "dpad", x: L + 58 * u, y: T + 112 * u, r: 40 * u, floating: false })
            this.sticks.push({ kind: "stick", side: "left", home: { x: L + 120 * u, y: B - 64 * u }, r: 82 * u, zone: leftZone, horizontal: true })
        } else if (layout == "retro") {
            shoulder("left", true)
            shoulder("right", true)
            face(R - 82 * u, B - 90 * u, 56 * u, 31 * u)
            this.dpads.push({ kind: "dpad", x: L + 96 * u, y: B - 96 * u, r: 64 * u, floating: true, zone: leftZone })
        } else if (layout == "action") {
            this.addButton({ id: "lb", label: "LB", bit: PAD.LB, shape: "pill", x: L + 43 * u, y: T + 22 * u, w: 86 * u, h: 42 * u, slop: 10 * u, group: "other" }, "ltpad-pill")
            this.addButton({ id: "rb", label: "RB", bit: PAD.RB, shape: "pill", x: R - 43 * u, y: T + 22 * u, w: 86 * u, h: 42 * u, slop: 10 * u, group: "other" }, "ltpad-pill")
            const fx = R - 70 * u
            const fy = B - 72 * u
            face(fx, fy, 45 * u, 24 * u)
            this.addButton({ id: "rt", label: "RT", bit: 0, trigger: "rt", look: true, shape: "circle", x: fx - 128 * u, y: fy + 22 * u, w: 84 * u, h: 84 * u, slop: 8 * u, group: "other" }, "ltpad-big")
            this.addButton({ id: "lt", label: "LT", bit: 0, trigger: "lt", shape: "circle", x: fx - 104 * u, y: fy - 98 * u, w: 62 * u, h: 62 * u, slop: 8 * u, group: "other" }, "ltpad-pill")
            this.dpads.push({ kind: "dpad", x: L + 214 * u, y: B - 44 * u, r: 40 * u, floating: false })
            this.sticks.push({ kind: "stick", side: "left", home: { x: L + 88 * u, y: B - 90 * u }, r: 58 * u, zone: leftZone, horizontal: false })
            this.looks.push({ kind: "look", zone: rightZone })
        } else {
            shoulder("left", true)
            shoulder("right", true)
            const fx = R - 80 * u
            const fy = B - 88 * u
            face(fx, fy, 51 * u, 27 * u)
            this.dpads.push({ kind: "dpad", x: L + 218 * u, y: B - 50 * u, r: 48 * u, floating: false })
            this.sticks.push({ kind: "stick", side: "left", home: { x: L + 88 * u, y: B - 92 * u }, r: 58 * u, zone: leftZone, horizontal: false })
            if (this.options.look == "touchpad") {
                this.looks.push({ kind: "look", zone: rightZone })
            } else {
                this.sticks.push({ kind: "stick", side: "right", home: { x: fx - 168 * u, y: B - 62 * u }, r: 54 * u, zone: rightZone, horizontal: false })
            }
        }

        this.build()
        this.render()
    }

    private addButton(def: Omit<ButtonCtl, "kind" | "value">, className: string): ButtonCtl {
        const button: ButtonCtl = { kind: "button", value: 0, ...def }
        const el = element("div", `ltpad-c ltpad-btn ${className}`)
        el.style.left = `${button.x - button.w / 2}px`
        el.style.top = `${button.y - button.h / 2}px`
        el.style.width = `${button.w}px`
        el.style.height = `${button.h}px`
        if (button.shape == "pedal") {
            el.classList.add("ltpad-pedal")
            button.fill = element("div", "ltpad-fill", el)
            const text = element("span", "", el)
            text.textContent = button.label
            const caption = element("small", "", text)
            caption.textContent = button.trigger == "rt" ? this.options.texts.gas : this.options.texts.brake
        } else if (button.svg) {
            el.innerHTML = button.svg
        } else if (button.tone) {
            const letter = element("b", "", el)
            letter.textContent = button.label
            letter.style.color = button.tone
        } else {
            el.textContent = button.label
        }
        button.el = el
        this.buttons.push(button)
        return button
    }

    private build() {
        this.surface.replaceChildren()
        for (const stick of this.sticks) {
            const base = element("div", "ltpad-c ltpad-stick" + (stick.horizontal ? " h" : ""), this.surface)
            const height = stick.horizontal ? 52 * this.unit : stick.r * 2
            base.style.width = `${stick.r * 2}px`
            base.style.height = `${height}px`
            const knob = element("div", "ltpad-knob", base)
            const knobSize = (stick.horizontal ? 40 : stick.r * 0.92) * (stick.horizontal ? this.unit : 1)
            knob.style.width = `${knobSize}px`
            knob.style.height = `${knobSize}px`
            const tag = element("div", "ltpad-stick-tag", base)
            tag.textContent = stick.side == "left" ? (stick.horizontal ? "◀ ▶" : "L") : "R"
            stick.base = base
            stick.knob = knob
        }
        for (const dpad of this.dpads) {
            const el = element("div", "ltpad-c ltpad-dpad" + (dpad.floating ? " float" : ""), this.surface)
            el.style.width = el.style.height = `${dpad.r * 2}px`
            el.innerHTML = SVG_DPAD
            dpad.el = el
        }
        for (const button of this.buttons) {
            if (button.el) {
                this.surface.appendChild(button.el)
            }
        }
        // Collapsed: a small button in the middle of the top edge brings the pad back
        const u = this.unit
        this.chip.style.left = `${this.area.x + this.area.w / 2 - 22 * u}px`
        this.chip.style.top = `${this.area.y + 10 * u}px`
    }

    // -- Input
    private onPointerDown(event: PointerEvent) {
        event.preventDefault()
        event.stopPropagation()
        this.events.onInteraction?.("down")
        if (!this.visible || this.collapsed) {
            return
        }
        try {
            this.surface.setPointerCapture(event.pointerId)
        } catch {
            // ok without capture
        }
        const [x, y] = this.toLocal(event.clientX, event.clientY)
        const now = performance.now()
        const finger: Finger = {
            id: event.pointerId, kind: "none", start: now, pressed: new Set(),
            cx: x, cy: y, x, y, rim: false, rimSince: 0, sprinted: false, dir: 0, value: 0,
        }
        this.fingers.set(event.pointerId, finger)

        // 1) face cluster (nearest within reach), 2) any other button, 3) D-pad, 4) zones
        const faceHit = this.faceHit(x, y)
        if (faceHit.size > 0) {
            finger.kind = "face"
            finger.pressed = faceHit
            this.tick()
        } else {
            const button = this.buttonAt(x, y)
            if (button) {
                if (button.extra) {
                    this.fingers.delete(event.pointerId)
                    try {
                        this.surface.releasePointerCapture(event.pointerId)
                    } catch {
                        // not captured
                    }
                    this.tick()
                    this.flash(button)
                    this.events.onExtra?.(button.extra)
                    return
                }
                finger.kind = "button"
                finger.button = button
                finger.pressed.add(button)
                button.value = button.analog ? this.pedalValue(button, y) : 1
                this.tick()
            } else {
                const dpad = this.dpads.find(d => !d.floating && Math.hypot(x - d.x, y - d.y) <= d.r + 12 * this.unit)
                    ?? this.dpads.find(d => d.floating && d.zone && inBox(d.zone, x, y))
                const stick = dpad ? undefined : this.sticks.find(s => inBox(s.zone, x, y))
                const look = dpad || stick ? undefined : this.looks.find(l => inBox(l.zone, x, y))
                if (dpad) {
                    finger.kind = "dpad"
                    finger.dpad = dpad
                    if (dpad.floating) {
                        finger.cx = x
                        finger.cy = y
                    } else {
                        finger.cx = dpad.x
                        finger.cy = dpad.y
                    }
                    this.updateDpad(finger)
                } else if (stick) {
                    finger.kind = "stick"
                    finger.stick = stick
                    // The base is born under the thumb, kept on screen
                    finger.cx = clamp(x, stick.r * 0.6, this.area.w - stick.r * 0.6)
                    finger.cy = stick.horizontal ? y : clamp(y, stick.r * 0.6, this.area.h - stick.r * 0.6)
                    const memory = this.stickMemory[stick.side]
                    if (now - memory.lastEnd < DOUBLE_TAP_GAP_MS && memory.lastDuration < DOUBLE_TAP_FIRST_MAX_MS && !stick.horizontal) {
                        this.pulse(stick.side == "left" ? PAD.LS : PAD.RS)
                        this.tick(true)
                    } else {
                        this.tick()
                    }
                } else if (look) {
                    finger.kind = "look"
                }
            }
        }
        this.render()
        this.emit()
        this.requestFrame()
    }

    private onPointerMove(event: PointerEvent) {
        const finger = this.fingers.get(event.pointerId)
        if (!finger) {
            return
        }
        event.preventDefault()
        event.stopPropagation()

        // Every sample of the gesture, not just the last one per frame (Chrome coalesces moves)
        const samples = typeof event.getCoalescedEvents == "function" ? event.getCoalescedEvents() : []
        const points = samples.length > 0 ? samples : [event]
        for (const point of points) {
            const [x, y] = this.toLocal(point.clientX, point.clientY)
            const dx = x - finger.x
            const dy = y - finger.y
            finger.x = x
            finger.y = y
            if (finger.kind == "look" || (finger.kind == "button" && finger.button?.look)) {
                this.lookAccX += dx
                this.lookAccY += dy
                this.lookLastMove = performance.now()
            }
        }

        if (finger.kind == "face") {
            const hit = this.faceHit(finger.x, finger.y)
            let added = false
            for (const button of hit) {
                if (!finger.pressed.has(button)) added = true
            }
            finger.pressed = hit
            if (added) this.tick()
        } else if (finger.kind == "button" && finger.button?.analog) {
            finger.button.value = this.pedalValue(finger.button, finger.y)
        } else if (finger.kind == "dpad") {
            this.updateDpad(finger)
        } else if (finger.kind == "stick" && finger.stick) {
            this.followStick(finger, finger.stick)
        }
        this.render()
        this.emit()
        this.requestFrame()
    }

    private onPointerUp(event: PointerEvent) {
        const finger = this.fingers.get(event.pointerId)
        if (!finger) {
            return
        }
        if (event.type == "pointerup") {
            this.events.onInteraction?.("up")
        }
        this.fingers.delete(event.pointerId)
        if (finger.kind == "stick" && finger.stick) {
            const memory = this.stickMemory[finger.stick.side]
            memory.lastEnd = performance.now()
            memory.lastDuration = memory.lastEnd - finger.start
        }
        if (finger.button && !this.isPressedByOther(finger.button)) {
            finger.button.value = 0
        }
        this.render()
        this.emit()
        this.requestFrame()
    }

    private isPressedByOther(button: ButtonCtl): boolean {
        for (const finger of this.fingers.values()) {
            if (finger.pressed.has(button)) return true
        }
        return false
    }

    /// Face buttons under a thumb: the nearest one within reach, plus its neighbour when the
    /// thumb sits between the two (A+B with one thumb, like on a real pad)
    private faceHit(x: number, y: number): Set<ButtonCtl> {
        const hit = new Set<ButtonCtl>()
        let first: ButtonCtl | null = null
        let firstDistance = Infinity
        let second: ButtonCtl | null = null
        let secondDistance = Infinity
        for (const button of this.buttons) {
            if (button.group != "face") continue
            const distance = Math.hypot(x - button.x, y - button.y)
            if (distance < firstDistance) {
                second = first
                secondDistance = firstDistance
                first = button
                firstDistance = distance
            } else if (distance < secondDistance) {
                second = button
                secondDistance = distance
            }
        }
        if (first && firstDistance <= first.w / 2 + first.slop) {
            hit.add(first)
            if (second && secondDistance <= second.w / 2 + second.slop && secondDistance - firstDistance < first.w * 0.3) {
                hit.add(second)
            }
        }
        return hit
    }

    private buttonAt(x: number, y: number): ButtonCtl | null {
        let best: ButtonCtl | null = null
        let bestDistance = Infinity
        for (const button of this.buttons) {
            if (button.group == "face") continue
            let distance: number
            if (button.shape == "circle") {
                distance = Math.hypot(x - button.x, y - button.y) - button.w / 2
            } else {
                const dx = Math.max(Math.abs(x - button.x) - button.w / 2, 0)
                const dy = Math.max(Math.abs(y - button.y) - button.h / 2, 0)
                distance = Math.hypot(dx, dy)
            }
            if (distance <= button.slop && distance < bestDistance) {
                best = button
                bestDistance = distance
            }
        }
        return best
    }

    /// Pedal: light at the bottom, floored at the top (the same feel as the Companion wheel)
    private pedalValue(button: ButtonCtl, y: number): number {
        const bottom = button.y + button.h / 2
        const fraction = clamp((bottom - y) / (button.h * 0.85), 0, 1)
        return 0.3 + 0.7 * fraction
    }

    private followStick(finger: Finger, stick: StickCtl) {
        const dx = finger.x - finger.cx
        const dy = stick.horizontal ? 0 : finger.y - finger.cy
        const distance = Math.hypot(dx, dy)
        if (distance > stick.r) {
            // The base trails a thumb that overshoots: turning back answers at once
            const pull = (distance - stick.r) / distance
            finger.cx += dx * pull
            finger.cy += dy * pull
        }
        const magnitude = Math.min(1, distance / stick.r)
        if (magnitude >= RIM_ON && !finger.rim) {
            finger.rim = true
            finger.rimSince = performance.now()
            this.tick()
        } else if (magnitude < RIM_OFF && finger.rim) {
            finger.rim = false
            finger.sprinted = false
        }
    }

    private updateDpad(finger: Finger) {
        const dpad = finger.dpad
        if (!dpad) {
            return
        }
        let dx = finger.x - finger.cx
        let dy = finger.y - finger.cy
        const distance = Math.hypot(dx, dy)
        if (dpad.floating && distance > dpad.r) {
            const pull = (distance - dpad.r) / distance
            finger.cx += dx * pull
            finger.cy += dy * pull
            dx = finger.x - finger.cx
            dy = finger.y - finger.cy
        }
        const dead = dpad.floating ? 12 * this.unit : dpad.r * 0.22
        let dir = 0
        if (Math.hypot(dx, dy) >= dead) {
            const angle = (Math.atan2(-dy, dx) * 180 / Math.PI + 360) % 360
            // Straight directions get 60 degrees each, diagonals 30: easier to hold a straight line
            if (angle < 30 || angle >= 330) dir = PAD.RIGHT
            else if (angle < 60) dir = PAD.RIGHT | PAD.UP
            else if (angle < 120) dir = PAD.UP
            else if (angle < 150) dir = PAD.UP | PAD.LEFT
            else if (angle < 210) dir = PAD.LEFT
            else if (angle < 240) dir = PAD.LEFT | PAD.DOWN
            else if (angle < 300) dir = PAD.DOWN
            else dir = PAD.DOWN | PAD.RIGHT
        }
        if (dir != finger.dir) {
            if (dir != 0) this.tick()
            finger.dir = dir
        }
    }

    private pulse(bit: number) {
        this.pulses.set(bit, performance.now() + PULSE_MS)
    }

    private tick(strong = false) {
        if (this.options.haptics) {
            this.haptics.tick(strong)
        }
    }

    private flash(button: ButtonCtl) {
        button.el?.classList.add("on")
        setTimeout(() => button.el?.classList.remove("on"), 140)
    }

    // -- Output
    private stickOutput(finger: Finger, stick: StickCtl): [number, number] {
        const dx = finger.x - finger.cx
        const dy = stick.horizontal ? 0 : finger.y - finger.cy
        const distance = Math.hypot(dx, dy)
        if (distance == 0) {
            return [0, 0]
        }
        const magnitude = Math.min(1, distance / stick.r)
        const live = (magnitude - STICK_DEAD_ZONE) / (1 - STICK_DEAD_ZONE)
        if (live <= 0) {
            return [0, 0]
        }
        const out = STICK_ANTI_DEAD_ZONE + (1 - STICK_ANTI_DEAD_ZONE) * Math.pow(live, STICK_CURVE)
        // XInput: Y up is positive
        return [dx / distance * out, -dy / distance * out]
    }

    private compute(): TouchGamepadState {
        const now = performance.now()
        const state = emptyTouchGamepadState()
        for (const finger of this.fingers.values()) {
            for (const button of finger.pressed) {
                state.buttons |= button.bit
                if (button.trigger == "lt") state.lt = Math.max(state.lt, button.value)
                if (button.trigger == "rt") state.rt = Math.max(state.rt, button.value)
            }
            if (finger.kind == "dpad") {
                state.buttons |= finger.dir
            } else if (finger.kind == "stick" && finger.stick) {
                const [x, y] = this.stickOutput(finger, finger.stick)
                if (finger.stick.side == "left") {
                    state.lx = x
                    state.ly = y
                    if (this.options.sprintAtEdge && finger.rim && !finger.sprinted && now - finger.rimSince >= SPRINT_HOLD_MS) {
                        finger.sprinted = true
                        this.pulse(PAD.LS)
                        this.tick(true)
                    }
                } else {
                    state.rx = x
                    state.ry = y
                }
            }
        }
        for (const [bit, until] of this.pulses) {
            if (until > now) {
                state.buttons |= bit
            } else {
                this.pulses.delete(bit)
            }
        }
        if (this.looks.length > 0 || this.buttons.some(b => b.look)) {
            state.rx = this.lookX
            state.ry = this.lookY
        }
        return state
    }

    private emit() {
        const state = this.compute()
        const last = this.lastState
        const same = state.buttons == last.buttons
            && Math.round(state.lt * 100) == Math.round(last.lt * 100)
            && Math.round(state.rt * 100) == Math.round(last.rt * 100)
            && Math.round(state.lx * 100) == Math.round(last.lx * 100)
            && Math.round(state.ly * 100) == Math.round(last.ly * 100)
            && Math.round(state.rx * 100) == Math.round(last.rx * 100)
            && Math.round(state.ry * 100) == Math.round(last.ry * 100)
        if (same) {
            return
        }
        this.lastState = state
        this.events.onState({ ...state })
    }

    private lookActive(): boolean {
        for (const finger of this.fingers.values()) {
            if (finger.kind == "look" || (finger.kind == "button" && finger.button?.look)) return true
        }
        return false
    }

    private requestFrame() {
        if (this.frameRequested || this.destroyed) {
            return
        }
        const busy = this.lookActive() || this.lookX != 0 || this.lookY != 0 || this.pulses.size > 0
            || (this.options.sprintAtEdge && [...this.fingers.values()].some(f => f.rim && !f.sprinted))
        if (!busy) {
            this.lastFrame = 0
            return
        }
        this.frameRequested = true
        requestAnimationFrame(this.onFrame.bind(this))
    }

    private onFrame(time: number) {
        this.frameRequested = false
        const dt = this.lastFrame > 0 ? clamp(time - this.lastFrame, 4, 50) : 16.7
        this.lastFrame = time

        // Drag to look: finger speed -> right stick. A thumb that pauses mid-drag (no new
        // sample yet) keeps the last speed for a moment instead of stuttering to zero.
        const now = performance.now()
        if (this.lookAccX != 0 || this.lookAccY != 0) {
            const perFrame = 16.7 / dt
            const vx = this.lookAccX * perFrame
            const vy = this.lookAccY * perFrame
            this.lookAccX = this.lookAccY = 0
            const speed = Math.hypot(vx, vy)
            if (speed < LOOK_MIN_PX_PER_FRAME) {
                this.lookTargetX = this.lookTargetY = 0
            } else {
                const out = Math.min(1, LOOK_ANTI_DEAD_ZONE + (1 - LOOK_ANTI_DEAD_ZONE) * speed * this.options.lookSensitivity / (LOOK_FULL_PX_PER_FRAME * this.unit))
                this.lookTargetX = vx / speed * out
                this.lookTargetY = -vy / speed * out
            }
        } else if (now - this.lookLastMove > LOOK_HOLD_MS || !this.lookActive()) {
            this.lookTargetX = this.lookTargetY = 0
        }
        this.lookX += (this.lookTargetX - this.lookX) * LOOK_SMOOTHING
        this.lookY += (this.lookTargetY - this.lookY) * LOOK_SMOOTHING
        if (Math.abs(this.lookX) < 0.01 && this.lookTargetX == 0) this.lookX = 0
        if (Math.abs(this.lookY) < 0.01 && this.lookTargetY == 0) this.lookY = 0

        this.render()
        this.emit()
        this.requestFrame()
    }

    // -- Drawing
    private render() {
        const pressed = new Set<ButtonCtl>()
        const activeSticks = new Map<StickCtl, Finger>()
        const activeDpads = new Map<DpadCtl, Finger>()
        for (const finger of this.fingers.values()) {
            for (const button of finger.pressed) pressed.add(button)
            if (finger.kind == "stick" && finger.stick) activeSticks.set(finger.stick, finger)
            if (finger.kind == "dpad" && finger.dpad) activeDpads.set(finger.dpad, finger)
        }
        for (const button of this.buttons) {
            const on = pressed.has(button)
            button.el?.classList.toggle("on", on)
            if (button.fill) {
                button.fill.style.height = `${on ? Math.round(button.value * 100) : 0}%`
            }
        }
        for (const stick of this.sticks) {
            const finger = activeSticks.get(stick)
            const base = stick.base
            const knob = stick.knob
            if (!base || !knob) continue
            const cx = finger ? finger.cx : stick.home.x
            const cy = finger ? finger.cy : stick.home.y
            const height = stick.horizontal ? 52 * this.unit : stick.r * 2
            base.style.left = `${cx - stick.r}px`
            base.style.top = `${cy - height / 2}px`
            base.classList.toggle("on", !!finger)
            base.classList.toggle("rim", !!finger?.rim)
            let kx = 0
            let ky = 0
            if (finger) {
                kx = clamp(finger.x - finger.cx, -stick.r, stick.r)
                ky = stick.horizontal ? 0 : finger.y - finger.cy
                const distance = Math.hypot(kx, ky)
                if (distance > stick.r) {
                    kx = kx / distance * stick.r
                    ky = ky / distance * stick.r
                }
            }
            knob.style.transform = `translate(calc(-50% + ${kx}px), calc(-50% + ${ky}px))`
        }
        for (const dpad of this.dpads) {
            const el = dpad.el
            if (!el) continue
            const finger = activeDpads.get(dpad)
            const cx = finger && dpad.floating ? finger.cx : dpad.x
            const cy = finger && dpad.floating ? finger.cy : dpad.y
            el.style.left = `${cx - dpad.r}px`
            el.style.top = `${cy - dpad.r}px`
            el.classList.toggle("on", !!finger)
            const dir = finger?.dir ?? 0
            el.querySelector(".u")?.classList.toggle("on", (dir & PAD.UP) != 0)
            el.querySelector(".d")?.classList.toggle("on", (dir & PAD.DOWN) != 0)
            el.querySelector(".l")?.classList.toggle("on", (dir & PAD.LEFT) != 0)
            el.querySelector(".r")?.classList.toggle("on", (dir & PAD.RIGHT) != 0)
        }
    }
}
