import { ControllerConfig } from "../stream/gamepad"
import { MouseMode, MouseScrollMode, TouchMode } from "../stream/input"
import { PageStyle } from "../styles/index"
import { getLanguageOptions, getTranslations, LanguageSetting, normalizeLanguage } from "../i18n"
import { Component, ComponentEvent } from "./index"
import { InputComponent, SelectComponent } from "./input"
import { SidebarEdge } from "./sidebar/index"
import { StreamPermissions } from "../api_bindings";

export type Settings = {
    sidebarEdge: SidebarEdge,
    hideSidebarButton: boolean,
    bitrate: number
    /// Lightning fork: "auto" (monitor's resolution with the physical monitor, this screen's with
    /// a virtual display), "full" (this screen, physical pixels), "safe" (this screen without the
    /// notch area). "native" is the old name of "full".
    videoSize: "auto" | "full" | "safe" | "720p" | "1080p" | "1440p" | "4k" | "native" | "custom"
    videoSizeCustom: {
        width: number
        height: number
    },
    fps: number
    /// Lightning fork: ask the host for a smaller resolution and upscale on this device.
    upscaling: boolean
    /// With a virtual display: how much of this device's resolution the host renders.
    upscalingRenderScale: UpscalingRenderScale
    /// Upscaler run on this device (FSR 1 = quality, NIS = balanced, SGSR = performance).
    upscalingAlgorithm: UpscalingAlgorithm
    videoCodec: StreamCodec,
    forceVideoElementRenderer: boolean
    canvasRenderer: boolean
    canvasVsync: boolean
    playAudioLocal: boolean
    mouseScrollMode: MouseScrollMode
    mouseMode: MouseMode
    touchMode: TouchMode
    localCursorSensitivity: number
    controllerConfig: ControllerConfig
    dataTransport: TransportType
    language: LanguageSetting
    enterFullscreenOnStreamStart: boolean
    toggleFullscreenWithKeybind: boolean
    pageStyle: PageStyle
    hdr: boolean
    useSelectElementPolyfill: boolean
}

export type StreamCodec = "h264" | "auto" | "h265" | "av1"
export type UpscalingRenderScale = "auto" | "75" | "67" | "50"
/// "auto": the governor (upscale_governor.ts) picks the best level this device keeps up with
export type UpscalingAlgorithm = "auto" | "fsr1" | "nis" | "sgsr" | "sharpen"
export type TransportType = "auto" | "webrtc" | "websocket"

import DEFAULT_SETTINGS from "../default_settings"

/// You should use the role default settings instead!
export function globalDefaultSettings(): Settings {
    // We are deep cloning this
    return deepClone(DEFAULT_SETTINGS)
}

function deepClone<T>(value: T): T {
    if (typeof structuredClone == "function") {
        return structuredClone(value)
    } else {
        return JSON.parse(JSON.stringify(value))
    }
}
function deepMerge(target: any, source: any) {
    for (const key in source) {
        const sourceVal = source[key]
        const targetVal = target[key]

        if (
            sourceVal &&
            typeof sourceVal === "object" &&
            !Array.isArray(sourceVal)
        ) {
            target[key] = deepMerge(
                targetVal && typeof targetVal === "object" ? targetVal : {},
                sourceVal
            )
        } else if (sourceVal !== undefined) {
            target[key] = sourceVal
        }
    }
    return target
}

export function getLocalStreamSettings(defaultSettings: Settings) {
    // Start with FULL global defaults
    let settings = globalDefaultSettings()

    // Fill/override with role defaults (even if partial)
    settings = deepMerge(settings, defaultSettings)

    try {
        const json = localStorage.getItem("mlSettings")
        if (json) {
            const loaded = JSON.parse(json)

            // Finally override with user settings
            settings = deepMerge(settings, loaded)
        }
    } catch (e) {
        localStorage.removeItem("mlSettings")
    }

    // Migration
    if (settings?.pageStyle === "old") {
        settings.pageStyle = "moonlight"
    }
    if (settings?.videoSize === "native") {
        settings.videoSize = "full"
    }

    return settings
}
export function setLocalStreamSettings(settings?: Settings) {
    localStorage.setItem("mlSettings", JSON.stringify(settings))
}

function settingsGroup(parent: HTMLElement, title: string): HTMLElement {
    const group = document.createElement("section")
    group.classList.add("settings-group")

    const header = document.createElement("h3")
    header.innerText = title
    group.appendChild(header)

    parent.appendChild(group)
    return group
}

export type StreamSettingsChangeListener =(event: ComponentEvent<StreamSettingsComponent>) => void

function makeSettingsValid(permissions: StreamPermissions, settings: Settings) {
    if (permissions.maximum_bitrate_kbps != null && permissions.maximum_bitrate_kbps < settings.bitrate) {
        settings.bitrate = permissions.maximum_bitrate_kbps
    }

    if (!permissions.allow_codec_av1 && settings.videoCodec == "av1") {
        settings.videoCodec = "h265"
    }
    if (!permissions.allow_codec_h265 && settings.videoCodec == "h265") {
        settings.videoCodec = "h264"
    }
    if (!permissions.allow_codec_h264 && settings.videoCodec == "h264") {
        settings.videoCodec = "auto"
    }

    if (!permissions.allow_hdr && settings.hdr) {
        settings.hdr = false
    }

    if (!permissions.allow_transport_webrtc && settings.dataTransport == "webrtc") {
        settings.dataTransport = "auto"
    }
    if (!permissions.allow_transport_websockets && settings.dataTransport == "websocket") {
        settings.dataTransport = "auto"
    }

    if (!Number.isFinite(settings.localCursorSensitivity) || settings.localCursorSensitivity <= 0) {
        settings.localCursorSensitivity = globalDefaultSettings().localCursorSensitivity
    }
}

export class StreamSettingsComponent implements Component {

    private permissions: StreamPermissions

    private divElement: HTMLDivElement = document.createElement("div")

    private sidebarHeader: HTMLHeadingElement = document.createElement("h3")
    private sidebarEdge: SelectComponent
    private hideSidebarButton: InputComponent

    private streamHeader: HTMLHeadingElement = document.createElement("h3")
    private bitrate: InputComponent
    private fps: SelectComponent
    private videoCodec: SelectComponent
    private forceVideoElementRenderer: InputComponent
    private canvasRenderer: InputComponent
    private canvasVsync: InputComponent
    private hdr: InputComponent

    private videoSize: SelectComponent
    private videoSizeWidth: InputComponent
    private videoSizeHeight: InputComponent
    private upscaling: InputComponent
    private upscalingRenderScale: SelectComponent
    private upscalingAlgorithm: SelectComponent

    private audioHeader: HTMLHeadingElement = document.createElement("h3")
    private playAudioLocal: InputComponent

    private mouseHeader: HTMLHeadingElement = document.createElement("h3")
    private mouseScrollMode: SelectComponent
    private mouseMode: SelectComponent
    private touchMode: SelectComponent
    private localCursorSensitivity: InputComponent

    private controllerHeader: HTMLHeadingElement = document.createElement("h3")
    private controllerInvertAB: InputComponent
    private controllerInvertXY: InputComponent
    private controllerSendIntervalOverride: InputComponent

    private otherHeader: HTMLHeadingElement = document.createElement("h3")
    private dataTransport: SelectComponent
    private language: SelectComponent
    private enterFullscreenOnStreamStart: InputComponent
    private toggleFullscreenWithKeybind: InputComponent

    private pageStyle: SelectComponent

    private useSelectElementPolyfill: InputComponent

    constructor(permissions: StreamPermissions, settings: Settings) {
        // Sometimes the normal settings object doesn't have some values, because they change between versions.
        // Use those as fallback
        const defaultSettings_ = globalDefaultSettings()

        makeSettingsValid(permissions, defaultSettings_)
        makeSettingsValid(permissions, settings)

        this.permissions = permissions
        const language = normalizeLanguage(settings?.language ?? defaultSettings_.language)
        const translations = getTranslations(language)
        const i = translations.settings
        const streamI = translations.stream

        // Root div
        this.divElement.classList.add("settings")

        // Sidebar
        this.sidebarHeader.innerText = i.sidebar
        this.divElement.appendChild(this.sidebarHeader)

        this.sidebarEdge = new SelectComponent("sidebarEdge", [
            { value: "left", name: i.left },
            { value: "right", name: i.right },
            { value: "up", name: i.up },
            { value: "down", name: i.down },
        ], {
            displayName: i.sidebarEdge,
            preSelectedOption: settings?.sidebarEdge ?? defaultSettings_.sidebarEdge,
        })
        this.sidebarEdge.addChangeListener(this.onSettingsChange.bind(this))
        this.sidebarEdge.mount(this.divElement)

        this.hideSidebarButton = new InputComponent("hideSidebarButton", "checkbox", i.hideSidebarButton, {
            checked: settings?.hideSidebarButton ?? defaultSettings_.hideSidebarButton
        })
        this.hideSidebarButton.addChangeListener(this.onSettingsChange.bind(this))
        this.hideSidebarButton.mount(this.divElement)

        // Video
        this.streamHeader.innerText = i.video
        this.divElement.appendChild(this.streamHeader)

        // Bitrate
        this.bitrate = new InputComponent("bitrate", "number", i.bitrate, {
            defaultValue: defaultSettings_.bitrate.toString(),
            value: settings?.bitrate?.toString(),
            step: "100",
            numberSlider: {
                range_min: Math.min(this.permissions.maximum_bitrate_kbps ?? 1000, 1000),
                range_max: this.permissions.maximum_bitrate_kbps ?? 10000,
            }
        })
        this.bitrate.addChangeListener(this.onSettingsChange.bind(this))
        this.bitrate.mount(this.divElement)

        // Fps (Lightning fork: the usual rates instead of a free number field)
        const fps = (settings?.fps ?? defaultSettings_.fps).toString()
        const fpsOptions = ["30", "60", "90", "120"]
        if (!fpsOptions.includes(fps)) {
            fpsOptions.push(fps)
        }
        this.fps = new SelectComponent("fps", fpsOptions.map(value => ({ value, name: value })), {
            displayName: i.fps,
            preSelectedOption: fps
        })
        this.fps.addChangeListener(this.onSettingsChange.bind(this))
        this.fps.mount(this.divElement)

        // Video Size
        this.videoSize = new SelectComponent("videoSize",
            [
                { value: "auto", name: i.videoSizeAuto },
                { value: "full", name: i.videoSizeFull },
                { value: "safe", name: i.videoSizeSafe },
                { value: "720p", name: "720p" },
                { value: "1080p", name: "1080p" },
                { value: "1440p", name: "1440p" },
                { value: "4k", name: "4K" },
                { value: "custom", name: i.custom }
            ],
            {
                displayName: i.videoSize,
                preSelectedOption: (settings?.videoSize == "native" ? "full" : settings?.videoSize) || defaultSettings_.videoSize
            }
        )
        this.videoSize.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSize.mount(this.divElement)

        this.videoSizeWidth = new InputComponent("videoSizeWidth", "number", i.videoWidth, {
            defaultValue: defaultSettings_.videoSizeCustom.width.toString(),
            value: settings?.videoSizeCustom?.width.toString()
        })
        this.videoSizeWidth.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSizeWidth.mount(this.divElement)

        this.videoSizeHeight = new InputComponent("videoSizeHeight", "number", i.videoHeight, {
            defaultValue: defaultSettings_.videoSizeCustom.height.toString(),
            value: settings?.videoSizeCustom?.height.toString()
        })
        this.videoSizeHeight.addChangeListener(this.onSettingsChange.bind(this))
        this.videoSizeHeight.mount(this.divElement)

        // Upscaling (Lightning fork): the host renders less, this device upscales
        this.upscaling = new InputComponent("upscaling", "checkbox", i.upscaling, {
            checked: settings?.upscaling ?? defaultSettings_.upscaling
        })
        this.upscaling.addChangeListener(this.onSettingsChange.bind(this))
        this.upscaling.mount(this.divElement)

        this.upscalingRenderScale = new SelectComponent("upscalingRenderScale",
            [
                { value: "auto", name: i.upscalingRenderScaleAuto },
                { value: "75", name: "75%" },
                { value: "67", name: "67%" },
                { value: "50", name: "50%" },
            ],
            {
                displayName: i.upscalingRenderScale,
                preSelectedOption: settings?.upscalingRenderScale || defaultSettings_.upscalingRenderScale
            }
        )
        this.upscalingRenderScale.addChangeListener(this.onSettingsChange.bind(this))
        this.upscalingRenderScale.mount(this.divElement)

        this.upscalingAlgorithm = new SelectComponent("upscalingAlgorithm",
            [
                { value: "auto", name: i.upscalingAuto },
                { value: "fsr1", name: "FSR 1" },
                { value: "nis", name: "NIS" },
                { value: "sgsr", name: "SGSR" },
                { value: "sharpen", name: i.upscalingSharpenOnly },
            ],
            {
                displayName: i.upscalingAlgorithm,
                preSelectedOption: settings?.upscalingAlgorithm || defaultSettings_.upscalingAlgorithm
            }
        )
        this.upscalingAlgorithm.addChangeListener(this.onSettingsChange.bind(this))
        this.upscalingAlgorithm.mount(this.divElement)

        // Codec
        const allowedVideoCodecs = [
            { value: "auto", name: i.codecAuto },
        ]
        if (this.permissions.allow_codec_h264) {
            allowedVideoCodecs.push(
                { value: "h264", name: "H264" },
            )
        }
        if (this.permissions.allow_codec_h265) {
            allowedVideoCodecs.push(
                { value: "h265", name: "H265" },
            )
        }
        if (this.permissions.allow_codec_av1) {
            allowedVideoCodecs.push(
                { value: "av1", name: i.av1Experimental }
            )
        }

        this.videoCodec = new SelectComponent("videoCodec", allowedVideoCodecs, {
            displayName: i.videoCodec,
            preSelectedOption: settings?.videoCodec ?? defaultSettings_.videoCodec
        })
        this.videoCodec.addChangeListener(this.onSettingsChange.bind(this))
        this.videoCodec.mount(this.divElement)

        // Force Video Element renderer
        this.forceVideoElementRenderer = new InputComponent("forceVideoElementRenderer", "checkbox", i.forceVideoElementRenderer, {
            checked: settings?.forceVideoElementRenderer ?? defaultSettings_.forceVideoElementRenderer
        })
        this.forceVideoElementRenderer.addChangeListener(this.onSettingsChange.bind(this))
        this.forceVideoElementRenderer.mount(this.divElement)

        // Use Canvas Renderer
        this.canvasRenderer = new InputComponent("canvasRenderer", "checkbox", i.useCanvasRenderer, {
            defaultValue: defaultSettings_.canvasRenderer.toString(),
            checked: settings === null || settings === void 0 ? void 0 : settings.canvasRenderer
        })
        this.canvasRenderer.addChangeListener(this.onSettingsChange.bind(this))
        this.canvasRenderer.mount(this.divElement)

        // Canvas VSync (Canvas only: sync draw to display refresh to reduce tearing; off = lower latency)
        this.canvasVsync = new InputComponent("canvasVsync", "checkbox", i.canvasVsync, {
            checked: settings?.canvasVsync ?? defaultSettings_.canvasVsync
        })
        this.canvasVsync.addChangeListener(this.onSettingsChange.bind(this))
        this.canvasVsync.mount(this.divElement)

        // HDR
        this.hdr = new InputComponent("hdr", "checkbox", i.enableHdr, {
            checked: settings?.hdr ?? defaultSettings_.hdr
        })
        this.hdr.addChangeListener(this.onSettingsChange.bind(this))
        this.hdr.mount(this.divElement)

        if (!this.permissions.allow_hdr) {
            this.hdr.setChecked(false)
            this.hdr.setEnabled(false)
        }

        // Audio local
        this.audioHeader.innerText = i.audio
        this.divElement.appendChild(this.audioHeader)

        this.playAudioLocal = new InputComponent("playAudioLocal", "checkbox", i.playAudioLocal, {
            checked: settings?.playAudioLocal
        })
        this.playAudioLocal.addChangeListener(this.onSettingsChange.bind(this))
        this.playAudioLocal.mount(this.divElement)

        // Mouse
        this.mouseHeader.innerText = i.mouse
        this.divElement.appendChild(this.mouseHeader)

        this.mouseScrollMode = new SelectComponent("mouseScrollMode",
            [
                { value: "highres", name: i.highRes },
                { value: "normal", name: i.normal }
            ],
            {
                displayName: i.scrollMode,
                preSelectedOption: settings?.mouseScrollMode || defaultSettings_.mouseScrollMode
            }
        )
        this.mouseScrollMode.addChangeListener(this.onSettingsChange.bind(this))
        this.mouseScrollMode.mount(this.divElement)

        this.mouseMode = new SelectComponent("mouseMode",
            [
                { value: "relative", name: streamI.relative },
                { value: "follow", name: streamI.follow },
                { value: "localCursor", name: streamI.localCursor },
                { value: "pointAndDrag", name: streamI.pointAndDrag }
            ],
            {
                displayName: i.startupMouseMode,
                preSelectedOption: settings?.mouseMode ?? defaultSettings_.mouseMode
            }
        )
        this.mouseMode.addChangeListener(this.onSettingsChange.bind(this))
        this.mouseMode.mount(this.divElement)

        this.touchMode = new SelectComponent("touchMode",
            [
                { value: "touch", name: streamI.touch },
                { value: "mouseRelative", name: streamI.relative },
                { value: "localCursor", name: streamI.localCursor },
                { value: "pointAndDrag", name: streamI.pointAndDrag }
            ],
            {
                displayName: i.startupTouchMode,
                preSelectedOption: settings?.touchMode ?? defaultSettings_.touchMode
            }
        )
        this.touchMode.addChangeListener(this.onSettingsChange.bind(this))
        this.touchMode.mount(this.divElement)

        this.localCursorSensitivity = new InputComponent("localCursorSensitivity", "number", i.localCursorSensitivity, {
            defaultValue: defaultSettings_.localCursorSensitivity.toString(),
            value: settings?.localCursorSensitivity?.toString(),
            step: "0.1",
            numberSlider: {
                range_min: 0.1,
                range_max: 3
            }
        })
        this.localCursorSensitivity.addChangeListener(this.onSettingsChange.bind(this))
        this.localCursorSensitivity.mount(this.divElement)

        // Controller
        if (window.isSecureContext) {
            this.controllerHeader.innerText = i.controller
        } else {
            this.controllerHeader.innerText = i.controllerDisabled
        }
        this.divElement.appendChild(this.controllerHeader)

        this.controllerInvertAB = new InputComponent("controllerInvertAB", "checkbox", i.invertAB, {
            checked: settings?.controllerConfig?.invertAB
        })
        this.controllerInvertAB.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerInvertAB.mount(this.divElement)

        this.controllerInvertXY = new InputComponent("controllerInvertXY", "checkbox", i.invertXY, {
            checked: settings?.controllerConfig?.invertXY
        })
        this.controllerInvertXY.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerInvertXY.mount(this.divElement)

        // Controller Send Interval
        this.controllerSendIntervalOverride = new InputComponent("controllerSendIntervalOverride", "number", i.overrideControllerInterval, {
            hasEnableCheckbox: true,
            defaultValue: "20",
            value: settings?.controllerConfig?.sendIntervalOverride?.toString(),
            numberSlider: {
                range_min: 10,
                range_max: 120
            }
        })
        this.controllerSendIntervalOverride.setEnabled(settings?.controllerConfig?.sendIntervalOverride != null)
        this.controllerSendIntervalOverride.addChangeListener(this.onSettingsChange.bind(this))
        this.controllerSendIntervalOverride.mount(this.divElement)

        if (!window.isSecureContext) {
            this.controllerInvertAB.setEnabled(false)
            this.controllerInvertXY.setEnabled(false)
        }

        // Other
        this.otherHeader.innerText = i.other
        this.divElement.appendChild(this.otherHeader)

        // Data Transport
        const allowedDataTransport = [
            { value: "auto", name: i.auto },
        ]
        if (this.permissions.allow_transport_webrtc) {
            allowedDataTransport.push(
                { value: "webrtc", name: "WebRTC" },
            )
        }
        if (this.permissions.allow_transport_websockets) {
            allowedDataTransport.push(
                { value: "websocket", name: i.webSocket },
            )
        }

        this.language = new SelectComponent("language", getLanguageOptions(i.languageAuto), {
            displayName: i.language,
            preSelectedOption: settings?.language ?? defaultSettings_.language
        })
        this.language.addChangeListener(this.onSettingsChange.bind(this))
        this.language.mount(this.divElement)

        this.dataTransport = new SelectComponent("transport", allowedDataTransport, {
            displayName: i.dataTransport,
            preSelectedOption: settings?.dataTransport ?? defaultSettings_.dataTransport
        })
        this.dataTransport.addChangeListener(this.onSettingsChange.bind(this))
        this.dataTransport.mount(this.divElement)

        this.enterFullscreenOnStreamStart = new InputComponent("enterFullscreenOnStreamStart", "checkbox", i.enterFullscreenOnStreamStart, {
            checked: settings?.enterFullscreenOnStreamStart ?? defaultSettings_.enterFullscreenOnStreamStart
        })
        this.enterFullscreenOnStreamStart.addChangeListener(this.onSettingsChange.bind(this))
        this.enterFullscreenOnStreamStart.mount(this.divElement)

        // Fullscreen Keybind
        this.toggleFullscreenWithKeybind = new InputComponent("toggleFullscreenWithKeybind", "checkbox", i.toggleFullscreenWithKeybind, {
            checked: settings?.toggleFullscreenWithKeybind
        })
        this.toggleFullscreenWithKeybind.addChangeListener(this.onSettingsChange.bind(this))
        this.toggleFullscreenWithKeybind.mount(this.divElement)

        // Page Style
        this.pageStyle = new SelectComponent("pageStyle", [
            { value: "standard", name: "Standard" },
            { value: "moonlight", name: "Moonlight" },
        ], {
            displayName: i.style,
            preSelectedOption: settings?.pageStyle ?? defaultSettings_.pageStyle
        })
        this.pageStyle.addChangeListener(this.onSettingsChange.bind(this))
        this.pageStyle.mount(this.divElement)

        // Custom Select Element
        this.useSelectElementPolyfill = new InputComponent("useSelectElementPolyfill", "checkbox", i.useCustomDropdown, {
            checked: settings?.useSelectElementPolyfill ?? defaultSettings_.useSelectElementPolyfill
        })
        this.useSelectElementPolyfill.addChangeListener(this.onSettingsChange.bind(this))
        this.useSelectElementPolyfill.mount(this.divElement)

        // Lightning fork: three groups instead of one long list; the options people rarely
        // touch fold away under "Advanced". Mounting again moves each element into its group.
        for (const header of [this.sidebarHeader, this.streamHeader, this.audioHeader, this.mouseHeader, this.controllerHeader, this.otherHeader]) {
            header.remove()
        }
        const quality = settingsGroup(this.divElement, i.groupQuality)
        for (const component of [
            this.videoSize, this.videoSizeWidth, this.videoSizeHeight, this.fps, this.bitrate,
            this.upscaling, this.upscalingAlgorithm, this.upscalingRenderScale, this.videoCodec, this.hdr,
        ]) {
            component.mount(quality)
        }
        const controls = settingsGroup(this.divElement, i.groupControls)
        for (const component of [
            this.touchMode, this.mouseMode, this.localCursorSensitivity, this.controllerInvertAB, this.controllerInvertXY,
        ]) {
            component.mount(controls)
        }
        const advanced = document.createElement("details")
        advanced.classList.add("settings-group", "settings-advanced")
        const advancedSummary = document.createElement("summary")
        advancedSummary.innerText = i.groupAdvanced
        advanced.appendChild(advancedSummary)
        this.divElement.appendChild(advanced)
        for (const component of [
            this.language, this.sidebarEdge, this.hideSidebarButton, this.enterFullscreenOnStreamStart,
            this.toggleFullscreenWithKeybind, this.playAudioLocal, this.mouseScrollMode,
            this.controllerSendIntervalOverride, this.dataTransport, this.forceVideoElementRenderer,
            this.canvasRenderer, this.canvasVsync, this.pageStyle, this.useSelectElementPolyfill,
        ]) {
            component.mount(advanced)
        }

        this.onSettingsChange()
    }

    private onSettingsChange() {
        const custom = this.videoSize.getValue() == "custom"
        this.videoSizeWidth.setEnabled(custom)
        this.videoSizeHeight.setEnabled(custom)
        this.videoSizeWidth.setVisible(custom)
        this.videoSizeHeight.setVisible(custom)

        const upscaling = this.upscaling.isChecked()
        this.upscalingAlgorithm.setVisible(upscaling)
        this.upscalingRenderScale.setVisible(upscaling)

        this.divElement.dispatchEvent(new ComponentEvent("ml-settingschange", this))
    }

    addChangeListener(listener: StreamSettingsChangeListener) {
        this.divElement.addEventListener("ml-settingschange", listener as any)
    }
    removeChangeListener(listener: StreamSettingsChangeListener) {
        this.divElement.removeEventListener("ml-settingschange", listener as any)
    }

    getStreamSettings(): Settings {
        const settings = globalDefaultSettings()

        settings.sidebarEdge = this.sidebarEdge.getValue() as any
        settings.hideSidebarButton = this.hideSidebarButton.isChecked()
        settings.bitrate = parseInt(this.bitrate.getValue())
        settings.fps = parseInt(this.fps.getValue() ?? "60")
        settings.videoSize = this.videoSize.getValue() as any
        settings.videoSizeCustom = {
            width: parseInt(this.videoSizeWidth.getValue()),
            height: parseInt(this.videoSizeHeight.getValue())
        }
        settings.upscaling = this.upscaling.isChecked()
        settings.upscalingRenderScale = this.upscalingRenderScale.getValue() as any
        settings.upscalingAlgorithm = this.upscalingAlgorithm.getValue() as any
        settings.videoCodec = this.videoCodec.getValue() as any
        settings.forceVideoElementRenderer = this.forceVideoElementRenderer.isChecked()
        settings.canvasRenderer = this.canvasRenderer.isChecked()
        settings.canvasVsync = this.canvasVsync.isChecked()

        settings.playAudioLocal = this.playAudioLocal.isChecked()

        settings.mouseScrollMode = this.mouseScrollMode.getValue() as any
        settings.mouseMode = this.mouseMode.getValue() as MouseMode
        settings.touchMode = this.touchMode.getValue() as TouchMode
        settings.localCursorSensitivity = parseFloat(this.localCursorSensitivity.getValue())

        settings.controllerConfig.invertAB = this.controllerInvertAB.isChecked()
        settings.controllerConfig.invertXY = this.controllerInvertXY.isChecked()
        if (this.controllerSendIntervalOverride.isEnabled()) {
            settings.controllerConfig.sendIntervalOverride = parseInt(this.controllerSendIntervalOverride.getValue())
        } else {
            settings.controllerConfig.sendIntervalOverride = null
        }

        settings.dataTransport = this.dataTransport.getValue() as any
        settings.language = this.language.getValue() as LanguageSetting

        settings.enterFullscreenOnStreamStart = this.enterFullscreenOnStreamStart.isChecked()
        settings.toggleFullscreenWithKeybind = this.toggleFullscreenWithKeybind.isChecked()

        settings.pageStyle = this.pageStyle.getValue() as any

        settings.hdr = this.hdr.isChecked()

        settings.useSelectElementPolyfill = this.useSelectElementPolyfill.isChecked()

        makeSettingsValid(this.permissions, settings)

        return settings
    }

    mountBefore(parent: HTMLElement, before: HTMLElement): void {
        parent.insertBefore(this.divElement, before)
    }
    mount(parent: HTMLElement): void {
        parent.appendChild(this.divElement)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.divElement)
    }
}
