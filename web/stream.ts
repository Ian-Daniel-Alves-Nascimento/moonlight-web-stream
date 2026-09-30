import { Api, apiGetAppImage, apiGetApps, apiGetRole, getApi } from "./api"
import { buildUrl } from "./config_"
import { installFetchBridge, notifyParentExit } from "./ponte"
import { iconButton, iconElement, ICON_BOLT, ICON_CHECK, ICON_CLOSE, ICON_ERROR, ICON_EXIT, ICON_FULLSCREEN, ICON_KEYBOARD, ICON_MENU, ICON_MOUSE, ICON_RETRY, ICON_ROTATE, ICON_SEND_KEY, ICON_STATS } from "./component/icons"
import { DetailedRole, StreamKeys } from "./api_bindings"
import { Component } from "./component/index"
import { SelectComponent } from "./component/input"
import { FormModal } from "./component/modal/form"
import { getModalBackground, Modal, showMessage, showModal } from "./component/modal/index"
import { showNotification } from "./component/notification"
import { getLocalStreamSettings, Settings, TransportType, UpscalingAlgorithm } from "./component/settings_menu"
import { getSidebarRoot, setSidebar, setSidebarExtended, setSidebarStyle, Sidebar } from "./component/sidebar/index"
import { adoptRoleDefaultLanguage, getCurrentLanguage, getTranslations, Language, normalizeLanguage } from "./i18n"
import { requestKeyboardLock } from "./iframe"
import "./polyfill/index"
import { KeyboardModeEvent, KeyboardModeWillChangeEvent, ScreenKeyboard, TextEvent } from "./screen_keyboard"
import { InfoEvent, Stream, StreamCapabilities, StreamFailure, StreamStage } from "./stream/index"
import { defaultStreamInputConfig, MouseMode, ScreenKeyboardSetVisibleEvent, StreamInputConfig } from "./stream/input"
import { emptyKeyModifiers } from "./stream/keyboard"
import { streamStatsToText } from "./stream/stats"
import { physicalScreenSize } from "./stream/upscaling"
import { avoidCodec, codecDisplayName } from "./stream/codec"
import "./styles/index"
import { LogLevel, uniffiInitAsync, Logger as UniffiLogger, setLogger as uniffiSetLogger } from "./uniffi/entry"

let I = getTranslations(getCurrentLanguage())

/// Lightning fork: how long after connecting the first picture may take before it's reported
const NO_VIDEO_TIMEOUT_MS = 12000
/// Lightning fork: the hidden menu button, and the three-finger tap that opens the menu
const MENU_BUTTON_PEEK_MS = 5000
const MENU_BUTTON_HOVER_PEEK_MS = 2500
const MENU_BUTTON_NEAR_PX = 90
const MENU_HINT_TIMES = 3
const MENU_TAP_MAX_MS = 450
const MENU_TAP_MAX_MOVE_PX = 30

async function startApp() {
    // Lightning fork: inside a same-origin page with ?ponte=1 the API goes through the parent (see ponte.ts)
    installFetchBridge()
    const uniffiInit = uniffiInitAsync()

    const api = await getApi()

    const queryParams = new URLSearchParams(location.search)
    let lang = parseLanguageFromQuery(queryParams)
    const bootstrapRole = await apiGetRole(api, { id: null })
    if (!lang) {
        adoptRoleDefaultLanguage(bootstrapRole.role.default_settings)
        lang = getCurrentLanguage()
    }
    I = getTranslations(lang)

    const rootElement = document.getElementById("root");
    if (rootElement == null) {
        showNotification(I.stream.rootNotFound, "error")
        return;
    }

    // Get Host and App via Query
    const hostIdStr = queryParams.get("hostId")
    const appIdStr = queryParams.get("appId")
    if (hostIdStr == null || appIdStr == null) {
        await showMessage(I.stream.missingHostOrApp)

        window.close()
        return
    }
    const hostId = Number.parseInt(hostIdStr)
    const appId = Number.parseInt(appIdStr)

    // event propagation on overlays
    const sidebarRoot = getSidebarRoot()
    if (sidebarRoot) {
        stopPropagationOn(sidebarRoot)
    }

    const modalBackground = getModalBackground()
    if (modalBackground) {
        stopPropagationOn(modalBackground)
    }

    // Wait for uniffi to finish it's initialization
    await uniffiInit
    // Set Uniffy Logger
    class CustomUniffiLogger implements UniffiLogger {
        log(level: LogLevel, message: string): void {
            switch (level) {
                case LogLevel.Trace:
                    console.trace(message)
                    break;
                case LogLevel.Debug:
                    console.debug(message)
                    break;
                case LogLevel.Warn:
                    console.warn(message)
                    break;
                case LogLevel.Info:
                    console.info(message)
                    break;
                case LogLevel.Error:
                    console.error(message)
                    break;
            }
        }
    }
    uniffiSetLogger(new CustomUniffiLogger(), LogLevel.Debug)

    // Start and Mount App
    const app = new ViewerApp(api, hostId, appId, bootstrapRole.role, parseSettingsFromQuery(queryParams))
    app.mount(rootElement);

    (window as any)["app"] = app
}

// Prevent starting transition
window.requestAnimationFrame(() => {
    // Note: elements is a live array
    const elements = document.getElementsByClassName("prevent-start-transition")
    while (elements.length > 0) {
        elements.item(0)?.classList.remove("prevent-start-transition")
    }
})

function parseSettingsFromQuery(queryParams: URLSearchParams): Partial<Settings> {
    const settings: Partial<Settings> = {}

    const bitrate = queryParams.get("bitrate")
    if (bitrate) {
        settings.bitrate = Number(bitrate)
    }

    const fps = queryParams.get("fps")
    if (fps) {
        settings.fps = Number(fps)
    }

    const hdr = queryParams.get("hdr")
    if (hdr != null) {
        settings.hdr = hdr === "true"
    }

    const videoSize = queryParams.get("videoSize")
    if (videoSize) {
        settings.videoSize = videoSize as Settings["videoSize"]
    }

    const width = queryParams.get("videoSizeCustom.width")
    const height = queryParams.get("videoSizeCustom.height")
    if (width && height) {
        settings.videoSizeCustom = {
            width: Number(width),
            height: Number(height),
        }
    }

    // Lightning fork
    const upscaling = queryParams.get("upscaling")
    if (upscaling) {
        settings.upscaling = upscaling == "true"
    }
    const upscalingRenderScale = queryParams.get("upscalingRenderScale")
    if (upscalingRenderScale) {
        settings.upscalingRenderScale = upscalingRenderScale as Settings["upscalingRenderScale"]
    }

    const upscalingAlgorithm = queryParams.get("upscalingAlgorithm")
    if (upscalingAlgorithm) {
        settings.upscalingAlgorithm = upscalingAlgorithm as Settings["upscalingAlgorithm"]
    }

    const dataTransport = queryParams.get("dataTransport")
    if (dataTransport) {
        settings.dataTransport = dataTransport as TransportType
    }

    return settings
}

function parseLanguageFromQuery(queryParams: URLSearchParams): Language | undefined {
    const language = queryParams.get("language")
    return language ? normalizeLanguage(language) : undefined
}

startApp()

class ViewerApp implements Component {
    private api: Api

    private sidebar: ViewerSidebar

    private div = document.createElement("div")

    private statsDiv = document.createElement("div")
    /// Lightning fork: asks to turn the phone sideways while it is upright (iOS can't lock it).
    private rotateHintDiv = document.createElement("div")
    /// Lightning fork: upscaler picked at start ("off" or an algorithm), read by the sidebar.
    upscalingChoice: string = "off"
    /// Lightning fork: progress/failure screen shown while connecting and when the stream stops.
    private connectScreen: ConnectScreen
    private exiting = false
    /// Lightning fork: the menu button stays hidden over the game; it shows for a moment after
    /// connecting, when the mouse comes near it, and a three-finger tap opens the menu.
    private menuHintDiv = document.createElement("div")
    private menuButtonPeekTimer: number | null = null
    private menuButtonHidden = false
    private menuTap: { start: number, origins: Map<number, [number, number]>, moved: boolean } | null = null
    private localTouchCursorDiv = document.createElement("div")
    private stream: Stream

    private inputConfig: StreamInputConfig = defaultStreamInputConfig()
    private previousMouseMode: MouseMode

    private autoEnterFullscreenOnStart: boolean = false
    private pendingAutoFullscreenPrompt: boolean = false
    private fullscreenPromptShown: boolean = false
    private fullscreenOnNextInteractionArmed: boolean = false
    private pendingAutoFullscreenTouchGesture: boolean = false
    private pendingAutoFullscreenMouseGesture: boolean = false
    private manualFullscreenExitRequested: boolean = false

    private toggleFullscreenWithKeybind: boolean = false

    private hasShownFullscreenEscapeWarning = false

    constructor(api: Api, hostId: number, appId: number, bootstrapRole: DetailedRole, options?: Partial<Settings>) {
        this.api = api

        const defaultSettings = getLocalStreamSettings(bootstrapRole.default_settings)
        const settings = {
            ...defaultSettings,
            ...options,
            videoSizeCustom: {
                ...defaultSettings.videoSizeCustom,
                ...options?.videoSizeCustom,
            },
        }
        Object.assign(this.inputConfig, {
            mouseMode: settings.mouseMode,
            mouseScrollMode: settings.mouseScrollMode,
            touchMode: settings.touchMode,
            localCursorSensitivity: settings.localCursorSensitivity,
            controllerConfig: settings.controllerConfig
        })

        this.upscalingChoice = settings.upscaling ? settings.upscalingAlgorithm : "off"

        // Configure sidebar
        this.sidebar = new ViewerSidebar(this)
        setSidebar(this.sidebar)
        document.querySelector("#sidebar-button .sidebar-button-image")?.replaceChildren(iconElement(ICON_MENU))

        this.connectScreen = new ConnectScreen(this)
        this.loadAppInfo(hostId, appId)

        // Configure stats element
        this.statsDiv.hidden = true
        this.statsDiv.classList.add("video-stats")
        this.localTouchCursorDiv.hidden = true
        this.localTouchCursorDiv.classList.add("local-touch-cursor")

        setInterval(() => {
            // Update stats display every 100ms
            const stats = this.getStream()?.getStats()
            if (stats && stats.isEnabled()) {
                this.statsDiv.hidden = false

                let text = streamStatsToText(stats.getCurrentStats())
                const upscaler = this.getStream()?.getUpscalerStats()
                if (upscaler) {
                    const level = upscaler.lastAlgorithm ?? "off"
                    const mode = upscaler.algorithm == "auto" ? `auto -> ${level}` : level
                    const gpu = upscaler.gpuMs != null ? `GPU ${upscaler.gpuMs.toFixed(1)} ms, ` : ""
                    text += `
Upscaler: ${mode} ${upscaler.input[0]}x${upscaler.input[1]} -> ${upscaler.output[0]}x${upscaler.output[1]} (${gpu}CPU ${upscaler.avgSubmitMs.toFixed(2)} ms, ${Math.round(upscaler.lateRatio * 100)}% late)`
                    if (upscaler.governorReason) {
                        text += `\n  auto: ${upscaler.governorReason}`
                    }
                }
                this.statsDiv.innerText = text
            } else {
                this.statsDiv.hidden = true
            }
        }, 100)
        this.div.appendChild(this.statsDiv)

        // Rotate hint: only on touch screens held upright
        this.rotateHintDiv.classList.add("rotate-device-hint")
        this.rotateHintDiv.appendChild(iconElement(ICON_ROTATE))
        const rotateText = document.createElement("p")
        rotateText.innerText = I.stream.rotateDevice
        this.rotateHintDiv.appendChild(rotateText)
        this.div.appendChild(this.rotateHintDiv)

        this.menuHintDiv.classList.add("lt-menu-hint")
        this.menuHintDiv.innerText = I.stream.menuHint
        this.menuHintDiv.hidden = true
        this.div.appendChild(this.menuHintDiv)
        this.div.appendChild(this.localTouchCursorDiv)

        // Configure stream
        this.previousMouseMode = this.inputConfig.mouseMode

        const browserWidth = Math.max(document.documentElement.clientWidth || 0, window.innerWidth || 0)
        const browserHeight = Math.max(document.documentElement.clientHeight || 0, window.innerHeight || 0)

        // "Safe area": the picture is fitted inside it, away from the notch (Lightning fork)
        document.body.classList.toggle("lt-video-safe", settings.videoSize == "safe")

        // Lightning fork: phones and tablets that allow it (Android; not iPhone Safari) go
        // fullscreen, locked sideways, on the first tap into the game: their browser bars
        // otherwise eat the screen and nothing else would hide them
        this.autoEnterFullscreenOnStart = settings.enterFullscreenOnStreamStart
            || (canUseFullscreen() && hasTouchScreen() && !hasFinePointer())
        this.toggleFullscreenWithKeybind = settings.toggleFullscreenWithKeybind

        this.stream = new Stream(this.api, hostId, appId, settings, [browserWidth, browserHeight], bootstrapRole.permissions)
        this.startStream(settings)

        // Configure input
        this.addListeners(document)
        this.addListeners(document.getElementById("input") as HTMLDivElement)

        window.addEventListener("blur", () => {
            this.stream.getInput().raiseAllKeys()
        })
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState !== "visible") {
                this.stream.getInput().raiseAllKeys()
            }
        })

        // When the page gets destroyed
        window.addEventListener("beforeunload", async () => {
            // Stop the current stream
            await this.stream.stop()
        })

        document.addEventListener("pointerlockchange", this.onPointerLockChange.bind(this))
        document.addEventListener("fullscreenchange", this.onFullscreenChange.bind(this))

        window.addEventListener("gamepadconnected", this.onGamepadConnect.bind(this))
        window.addEventListener("gamepaddisconnected", this.onGamepadDisconnect.bind(this))
        // Connect all gamepads
        for (const gamepad of navigator.getGamepads()) {
            if (gamepad != null) {
                this.onGamepadAdd(gamepad)
            }
        }
    }
    private addListeners(element: GlobalEventHandlers) {
        element.addEventListener("keydown", this.onKeyDown.bind(this), { passive: false })
        element.addEventListener("keyup", this.onKeyUp.bind(this), { passive: false })
        element.addEventListener("paste", this.onPaste.bind(this))

        element.addEventListener("mousedown", this.onMouseButtonDown.bind(this), { passive: false })
        element.addEventListener("mouseup", this.onMouseButtonUp.bind(this), { passive: false })
        element.addEventListener("mousemove", this.onMouseMove.bind(this), { passive: false })
        element.addEventListener("wheel", this.onMouseWheel.bind(this), { passive: false })
        element.addEventListener("contextmenu", this.onContextMenu.bind(this), { passive: false })

        element.addEventListener("touchstart", this.onTouchStart.bind(this), { passive: false })
        element.addEventListener("touchend", this.onTouchEnd.bind(this), { passive: false })
        element.addEventListener("touchcancel", this.onTouchCancel.bind(this), { passive: false })
        element.addEventListener("touchmove", this.onTouchMove.bind(this), { passive: false })
    }

    private async startStream(settings: Settings) {
        setSidebarStyle({
            edge: settings.sidebarEdge,
        })

        // Lightning fork: the menu button is always hidden over the game (see peekMenuButton);
        // "hide sidebar button" now also skips showing it for a moment after connecting
        this.menuButtonHidden = settings.hideSidebarButton

        // Add app info listener
        this.stream.addInfoListener(this.onInfo.bind(this))

        // Connect screen: plain progress, and the reason + what to do when it fails
        this.stream.addInfoListener(this.connectScreen.onInfo.bind(this.connectScreen))
        showModal(this.connectScreen)

        // Start animation frame loop
        this.onTouchUpdate()
        this.onGamepadUpdate()

        this.stream.getInput().addScreenKeyboardVisibleEvent(this.onScreenKeyboardSetVisible.bind(this))

        this.stream.mount(this.div)

        if (this.autoEnterFullscreenOnStart) {
            this.pendingAutoFullscreenPrompt = true
        }
    }

    private async onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "app") {
            const appName = data.appName

            document.title = appName
            this.sidebar.setTitle(appName)
        } else if (data.type == "connectionComplete") {
            this.sidebar.onCapabilitiesChange(data.capabilities)

            this.armFullscreenOnNextInteraction()
            setTimeout(this.checkVideoArrived.bind(this), NO_VIDEO_TIMEOUT_MS)

            if (!this.menuButtonHidden) {
                this.peekMenuButton(MENU_BUTTON_PEEK_MS)
            }
            this.showMenuHintOnce()
        }
    }

    // -- Menu button and gesture (Lightning fork)
    /// Shows the (normally invisible) menu button for a while.
    private peekMenuButton(ms: number) {
        const root = getSidebarRoot()
        root?.classList.add("lt-menu-peek")

        if (this.menuButtonPeekTimer != null) {
            clearTimeout(this.menuButtonPeekTimer)
        }
        this.menuButtonPeekTimer = window.setTimeout(() => {
            root?.classList.remove("lt-menu-peek")
            this.menuButtonPeekTimer = null
        }, ms)
    }
    /// The first few streams explain the gesture next to the button.
    private showMenuHintOnce() {
        let shown = 0
        try {
            shown = Number(localStorage.getItem("ltMenuHintShown") ?? "0")
            localStorage.setItem("ltMenuHintShown", String(shown + 1))
        } catch {
            // Private mode: show it every time
        }
        if (shown >= MENU_HINT_TIMES) {
            return
        }

        this.menuHintDiv.hidden = false
        setTimeout(() => this.menuHintDiv.hidden = true, MENU_BUTTON_PEEK_MS)
    }
    /// A quick tap with three fingers (no swipe: three fingers swiping up/down is the keyboard).
    private trackMenuTap(event: TouchEvent, phase: "start" | "move" | "end" | "cancel") {
        if (phase == "start") {
            if (event.touches.length == 3 && !this.menuTap) {
                const origins = new Map<number, [number, number]>()
                for (const touch of event.touches) {
                    origins.set(touch.identifier, [touch.clientX, touch.clientY])
                }
                this.menuTap = { start: performance.now(), origins, moved: false }
            } else if (event.touches.length > 3) {
                this.menuTap = null
            }
            return
        }

        const tap = this.menuTap
        if (!tap) {
            return
        }
        if (phase == "cancel") {
            this.menuTap = null
        } else if (phase == "move") {
            for (const touch of event.changedTouches) {
                const origin = tap.origins.get(touch.identifier)
                if (origin && Math.hypot(touch.clientX - origin[0], touch.clientY - origin[1]) > MENU_TAP_MAX_MOVE_PX) {
                    tap.moved = true
                }
            }
        } else if (event.touches.length == 0) {
            this.menuTap = null
            if (!tap.moved && performance.now() - tap.start < MENU_TAP_MAX_MS) {
                setSidebarExtended(true)
            }
        }
    }
    /// With a mouse, the button shows when the pointer comes near it.
    private peekMenuButtonNearPointer(event: MouseEvent) {
        const button = document.getElementById("sidebar-button")
        if (!button) {
            return
        }
        const rect = button.getBoundingClientRect()
        const dx = Math.max(rect.left - event.clientX, 0, event.clientX - rect.right)
        const dy = Math.max(rect.top - event.clientY, 0, event.clientY - rect.bottom)
        if (Math.hypot(dx, dy) < MENU_BUTTON_NEAR_PX) {
            this.peekMenuButton(MENU_BUTTON_HOVER_PEEK_MS)
        }
    }

    /// Restarts the stream with upscaling turned on/off, when that changes the resolution the
    /// host has to render. The app keeps running on the PC; the new stream picks it up.
    reconnectWithUpscaling(choice: UpscalingAlgorithm | "off") {
        this.exiting = true

        const url = new URL(location.href)
        url.searchParams.set("upscaling", String(choice != "off"))
        if (choice != "off") {
            url.searchParams.set("upscalingAlgorithm", choice)
        }
        location.replace(url.toString())
    }

    /// Lightning fork: connected but no picture (e.g. the PC's encoder refused the resolution)
    /// used to be a silent black screen. Only the <video> renderer can tell; canvas ones skip it.
    private checkVideoArrived() {
        const video = document.querySelector<HTMLVideoElement>("video.video-stream")
        if (!video || video.videoWidth > 0 || this.exiting) {
            return
        }

        // With the automatic codec, a codec above H.264 that shows nothing is left out on this
        // device from now on, and the stream restarts (the next attempt falls back to H.264)
        const codec = this.stream.getVideoCodec()
        if (this.stream.usesAutoCodec() && codec && codec != "h264") {
            avoidCodec(codec)
            this.exiting = true
            location.reload()
            return
        }

        this.connectScreen.showFailure("noVideo")
    }

    /// Lightning fork: title and cover of the app for the connect screen and the menu.
    private async loadAppInfo(hostId: number, appId: number) {
        try {
            const app = (await apiGetApps(this.api, { host_id: hostId })).find(app => app.app_id == appId)
            if (app) {
                document.title = app.title
                this.connectScreen.setTitle(app.title)
                this.sidebar.setTitle(app.title)
            }

            const image = await apiGetAppImage(this.api, { host_id: hostId, app_id: appId, force_refresh: false })
            if (image.size > 0 && image.type.startsWith("image/")) {
                this.connectScreen.setCover(URL.createObjectURL(image))
            }
        } catch (error) {
            // Only cosmetic: the screens keep their generic look
            console.debug("couldn't load app info", error)
        }
    }

    isExiting(): boolean {
        return this.exiting
    }
    /// Stops the stream and leaves the page: back to where the player came from, or to the
    /// list of apps when there is nowhere to go back to (opened directly / closing refused).
    async exitStream() {
        this.exiting = true
        showModal(null)

        const success = await this.stream.stop()
        if (!success) {
            console.debug("Failed to close stream correctly")
        }

        // Embedded (ponte.ts): the parent page closes the player
        if (notifyParentExit()) return

        if (history.length > 1) {
            history.back()
        } else {
            window.close()
        }
        setTimeout(() => {
            location.href = buildUrl("/")
        }, 500)
    }

    private focusInput() {
        if (this.stream.getInput().getCurrentPredictedTouchAction() != "screenKeyboard" && !this.sidebar.getScreenKeyboard().isVisible()) {
            const inputElement = document.getElementById("input") as HTMLDivElement
            inputElement.focus()
        }
    }

    onUserInteraction() {
        this.focusInput()

        this.stream.getVideoRenderer()?.onUserInteraction()
        this.stream.getAudioPlayer()?.onUserInteraction()
    }

    // -- Auto Fullscreen
    private armFullscreenOnNextInteraction() {
        if (this.autoEnterFullscreenOnStart) {
            this.fullscreenOnNextInteractionArmed = true
        }
    }
    private consumeAutoFullscreenInteraction(): boolean {
        if (!this.fullscreenOnNextInteractionArmed || this.isFullscreen()) {
            return false
        }

        this.fullscreenOnNextInteractionArmed = false
        void this.requestFullscreen().then(() => {
            if (!this.isFullscreen()) {
                this.armFullscreenOnNextInteraction()
            }
        })
        return true
    }
    private beginAutoFullscreenTouchGesture(): boolean {
        if (!this.fullscreenOnNextInteractionArmed || this.isFullscreen()) {
            return false
        }

        this.pendingAutoFullscreenTouchGesture = true
        return true
    }
    private consumeAutoFullscreenTouchGesture(): boolean {
        if (!this.pendingAutoFullscreenTouchGesture) {
            return false
        }

        this.pendingAutoFullscreenTouchGesture = false
        return this.consumeAutoFullscreenInteraction()
    }

    private onScreenKeyboardSetVisible(event: ScreenKeyboardSetVisibleEvent) {
        console.info(event.detail)
        const screenKeyboard = this.sidebar.getScreenKeyboard()

        const newShown = event.detail.visible
        if (newShown != screenKeyboard.isVisible()) {
            if (newShown) {
                screenKeyboard.show()
            } else {
                screenKeyboard.hide()
            }
        }
    }

    // Input
    getInputConfig(): StreamInputConfig {
        return this.inputConfig
    }
    setInputConfig(config: StreamInputConfig) {
        Object.assign(this.inputConfig, config)

        this.stream.getInput().setConfig(this.inputConfig)
        this.renderLocalTouchCursor()
    }

    // Keyboard
    onKeyDown(event: KeyboardEvent) {
        this.onUserInteraction()

        console.debug(event)
        if (event.shiftKey && event.ctrlKey && event.code == "KeyV") {
            // We are likely pasting -> don't send keys
        } else if (event.code == "F11") {
            // Allow manual fullscreen
        } else {
            event.preventDefault()
            this.stream.getInput().onKeyDown(event)
        }

        event.stopPropagation()
    }

    private isTogglingFullscreenWithKeybind: "waitForCtrl" | "makingFullscreen" | "none" = "none"
    onKeyUp(event: KeyboardEvent) {
        this.onUserInteraction()

        event.preventDefault()
        this.stream.getInput().onKeyUp(event)
        event.stopPropagation()

        if (this.toggleFullscreenWithKeybind && this.isTogglingFullscreenWithKeybind == "none" && event.ctrlKey && event.shiftKey && event.code == "KeyI") {
            this.isTogglingFullscreenWithKeybind = "waitForCtrl"
        }
        if (this.isTogglingFullscreenWithKeybind == "waitForCtrl" && (event.code == "ControlRight" || event.code == "ControlLeft")) {
            this.isTogglingFullscreenWithKeybind = "makingFullscreen";

            (async () => {
                if (this.isFullscreen()) {
                    await this.exitPointerLock()
                    await this.exitFullscreen()
                } else {
                    await this.requestFullscreen()
                    await this.requestPointerLock()
                }

                this.isTogglingFullscreenWithKeybind = "none"
            })()
        }
    }

    onPaste(event: ClipboardEvent) {
        this.onUserInteraction()

        this.stream.getInput().onPaste(event)

        event.stopPropagation()
    }

    // Mouse
    onMouseButtonDown(event: MouseEvent) {
        if (this.consumeAutoFullscreenInteraction()) {
            this.pendingAutoFullscreenMouseGesture = true
            event.preventDefault()
            event.stopPropagation()
            return
        }

        this.onUserInteraction()

        event.preventDefault()
        this.stream.getInput().onMouseDown(event, this.getStreamRect());

        event.stopPropagation()
    }
    onMouseButtonUp(event: MouseEvent) {
        if (this.pendingAutoFullscreenMouseGesture) {
            this.pendingAutoFullscreenMouseGesture = false
            event.preventDefault()
            event.stopPropagation()
            return
        }

        this.onUserInteraction()

        event.preventDefault()
        this.stream.getInput().onMouseUp(event)

        event.stopPropagation()
    }
    onMouseMove(event: MouseEvent) {
        this.peekMenuButtonNearPointer(event)

        if (this.pendingAutoFullscreenMouseGesture) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        event.preventDefault()
        this.stream.getInput().onMouseMove(event, this.getStreamRect())

        event.stopPropagation()
    }
    onMouseWheel(event: WheelEvent) {
        event.preventDefault()
        this.stream.getInput().onMouseWheel(event)

        event.stopPropagation()
    }
    onContextMenu(event: MouseEvent) {
        event.preventDefault()

        event.stopPropagation()
    }

    // Touch
    onTouchStart(event: TouchEvent) {
        this.trackMenuTap(event, "start")

        if (this.beginAutoFullscreenTouchGesture()) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        this.onUserInteraction()

        event.preventDefault()
        this.stream.getInput().onTouchStart(event, this.getStreamRect())

        event.stopPropagation()
    }
    onTouchEnd(event: TouchEvent) {
        this.trackMenuTap(event, "end")

        if (this.consumeAutoFullscreenTouchGesture()) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        this.onUserInteraction()

        event.preventDefault()
        this.stream.getInput().onTouchEnd(event, this.getStreamRect())

        event.stopPropagation()
    }
    onTouchCancel(event: TouchEvent) {
        this.trackMenuTap(event, "cancel")

        if (this.pendingAutoFullscreenTouchGesture) {
            this.pendingAutoFullscreenTouchGesture = false
            event.preventDefault()
            event.stopPropagation()
            return
        }

        this.pendingAutoFullscreenTouchGesture = false

        this.onUserInteraction()

        event?.preventDefault()
        this.stream.getInput().onTouchCancel(event, this.getStreamRect())

        event.stopPropagation()
    }
    onTouchUpdate() {
        window.requestAnimationFrame(this.onTouchUpdate.bind(this))

        this.stream.getInput().onTouchUpdate(this.getStreamRect())
        this.updateKeyboardViewportVideoOffset()
        this.renderLocalTouchCursor()
    }
    onTouchMove(event: TouchEvent) {
        this.trackMenuTap(event, "move")

        if (this.pendingAutoFullscreenTouchGesture) {
            event.preventDefault()
            event.stopPropagation()
            return
        }

        event.preventDefault()
        this.stream.getInput().onTouchMove(event, this.getStreamRect())

        event.stopPropagation()
    }

    // Gamepad
    onGamepadConnect(event: GamepadEvent) {
        this.onGamepadAdd(event.gamepad)
    }
    onGamepadAdd(gamepad: Gamepad) {
        this.stream.getInput().onGamepadConnect(gamepad)
    }
    onGamepadDisconnect(event: GamepadEvent) {
        this.stream.getInput().onGamepadDisconnect(event)
    }
    onGamepadUpdate() {
        window.requestAnimationFrame(this.onGamepadUpdate.bind(this))

        this.stream.getInput().onGamepadUpdate()
    }

    // Fullscreen
    async requestFullscreen(showEscapeWarning: boolean = true) {
        const body = document.body
        if (body) {
            if (!("requestFullscreen" in body && typeof body.requestFullscreen == "function")) {
                await showMessage(I.stream.fullscreenUnsupported)

                return
            }

            this.focusInput()

            if (!this.isFullscreen()) {
                try {
                    await body.requestFullscreen({
                        navigationUI: "hide"
                    })
                } catch (e) {
                    console.warn("failed to request fullscreen", e)
                }
            }

            try {
                await requestKeyboardLock();
                if (showEscapeWarning && !this.hasShownFullscreenEscapeWarning) {
                    showNotification(I.stream.fullscreenEscapeHint, "info")
                    this.hasShownFullscreenEscapeWarning = true
                }
            } catch (e) {
                console.warn("Keyboard lock failed, skipping notification.", e);
            }

            if (this.getStream()?.getInput().getConfig().mouseMode == "relative") {
                await this.requestPointerLock()
            }

            try {
                if (screen && "orientation" in screen) {
                    const orientation = screen.orientation

                    if ("lock" in orientation && typeof orientation.lock == "function") {
                        await orientation.lock("landscape")
                    }
                }
            } catch (e) {
                console.warn("failed to set orientation to landscape", e)
            }
        } else {
            console.warn("root element not found")
        }
    }
    async exitFullscreen() {
        if ("keyboard" in navigator && navigator.keyboard && "unlock" in navigator.keyboard) {
            await navigator.keyboard.unlock()
        }

        if ("exitFullscreen" in document && typeof document.exitFullscreen == "function") {
            await document.exitFullscreen()
        }
    }
    isFullscreen(): boolean {
        return "fullscreenElement" in document && !!document.fullscreenElement
    }
    private async onFullscreenChange() {
        if (this.isFullscreen()) {
            this.fullscreenOnNextInteractionArmed = false
            this.pendingAutoFullscreenTouchGesture = false
            this.pendingAutoFullscreenMouseGesture = false
            this.manualFullscreenExitRequested = false
        } else {
            const manualExit = this.manualFullscreenExitRequested
            this.manualFullscreenExitRequested = false

            if (this.autoEnterFullscreenOnStart && !manualExit) {
                this.armFullscreenOnNextInteraction()
            }
        }

        this.checkFullyImmersed()
    }
    markManualFullscreenExitRequested() {
        this.manualFullscreenExitRequested = true
    }

    // Pointer Lock
    async requestPointerLock(errorIfNotFound: boolean = false) {
        this.previousMouseMode = this.inputConfig.mouseMode

        const inputElement = document.getElementById("input") as HTMLDivElement

        if (inputElement && "requestPointerLock" in inputElement && typeof inputElement.requestPointerLock == "function") {
            this.focusInput()

            this.inputConfig.mouseMode = "relative"
            this.setInputConfig(this.inputConfig)

            setSidebarExtended(false)

            const onLockError = () => {
                document.removeEventListener("pointerlockerror", onLockError)

                // Fallback: try to request pointer lock without options
                inputElement.requestPointerLock()
            }

            document.addEventListener("pointerlockerror", onLockError, { once: true })

            try {
                let promise = inputElement.requestPointerLock({
                    unadjustedMovement: true
                })

                if (promise) {
                    await promise
                } else {
                    inputElement.requestPointerLock()
                }
            } catch (error) {
                // Some platforms do not support unadjusted movement. If you
                // would like PointerLock anyway, request again.
                if (error instanceof Error && error.name == "NotSupportedError") {
                    inputElement.requestPointerLock()
                } else {
                    throw error
                }
            } finally {
                document.removeEventListener("pointerlockerror", onLockError)
            }

        } else if (errorIfNotFound) {
            await showMessage(I.stream.pointerLockUnsupported)
        }
    }
    async exitPointerLock() {
        if ("exitPointerLock" in document && typeof document.exitPointerLock == "function") {
            document.exitPointerLock()
        }
    }
    private onPointerLockChange() {
        this.checkFullyImmersed()

        if (!document.pointerLockElement) {
            this.inputConfig.mouseMode = this.previousMouseMode
            this.setInputConfig(this.inputConfig)
        }
    }

    // -- Fully immersed Fullscreen -> Fullscreen API + Pointer Lock
    private checkFullyImmersed() {
        if ("pointerLockElement" in document && document.pointerLockElement &&
            "fullscreenElement" in document && document.fullscreenElement) {
            // We're fully immersed -> remove sidebar
            setSidebar(null)
        } else {
            setSidebar(this.sidebar)
        }
    }

    private renderLocalTouchCursor() {
        const localCursorState = this.stream.getInput().getLocalCursorState()
        if (!localCursorState?.visible) {
            this.localTouchCursorDiv.hidden = true
            return
        }

        const rect = this.getStreamRect()
        if (rect.width <= 0 || rect.height <= 0) {
            this.localTouchCursorDiv.hidden = true
            return
        }

        this.localTouchCursorDiv.hidden = false
        this.localTouchCursorDiv.style.left = `${rect.left + localCursorState.x * rect.width}px`
        this.localTouchCursorDiv.style.top = `${rect.top + localCursorState.y * rect.height}px`
    }

    // -- Keyboard Mode
    private keyboardViewportBaselineHeight: number | null = null
    private streamVideoTopOffsetPx: number = 0

    onScreenKeyboardModeWillChange(event: KeyboardModeWillChangeEvent) {
        if (event.detail.enabled) {
            this.captureKeyboardViewportBaseline()
        }
    }

    private captureKeyboardViewportBaseline() {
        this.keyboardViewportBaselineHeight = window.visualViewport?.height ?? null
        this.streamVideoTopOffsetPx = 0
        this.applyStreamVideoTopOffset()
        this.updateKeyboardFloatingButtonPosition()
    }
    resetKeyboardViewportVideoOffset() {
        this.keyboardViewportBaselineHeight = null
        this.streamVideoTopOffsetPx = 0
        this.applyStreamVideoTopOffset()
        this.resetKeyboardFloatingButtonPosition()
    }
    private updateKeyboardViewportVideoOffset() {
        this.updateKeyboardFloatingButtonPosition()

        const screenKeyboard = this.sidebar.getScreenKeyboard()
        const visualViewport = window.visualViewport
        const baselineHeight = this.keyboardViewportBaselineHeight
        const localCursorState = this.stream.getInput().getLocalCursorState()

        if (!screenKeyboard.isVisible() || !visualViewport || baselineHeight == null) {
            if (this.streamVideoTopOffsetPx != 0 && !screenKeyboard.isVisible()) {
                this.resetKeyboardViewportVideoOffset()
            }
            return
        }

        const viewportShrink = baselineHeight - visualViewport.height
        if (viewportShrink < 80) {
            if (this.streamVideoTopOffsetPx != 0) {
                this.streamVideoTopOffsetPx = 0
                this.applyStreamVideoTopOffset()
            }
            return
        }

        const streamRect = this.getStreamRect()
        if (streamRect.width <= 0 || streamRect.height <= 0) {
            return
        }

        const visibleTop = visualViewport.offsetTop
        const visibleBottom = visualViewport.offsetTop + visualViewport.height

        let newTopOffsetPx = this.streamVideoTopOffsetPx
        if (localCursorState.visible) {
            let delta = 0

            const safeMargin = Math.min(100, visualViewport.height * 0.25)
            const cursorY = streamRect.top + localCursorState.y * streamRect.height

            if (cursorY < visibleTop + safeMargin) {
                delta = visibleTop + safeMargin - cursorY
            } else if (cursorY > visibleBottom - safeMargin) {
                delta = visibleBottom - safeMargin - cursorY
            }

            newTopOffsetPx += delta
        } else {
            const screenTopToVideoTop = visualViewport.height - streamRect.height
            if (screenTopToVideoTop > 0) {
                newTopOffsetPx = visibleTop - screenTopToVideoTop
            }
        }

        if (Math.abs(newTopOffsetPx - this.streamVideoTopOffsetPx) >= 1) {
            this.streamVideoTopOffsetPx = newTopOffsetPx
            this.applyStreamVideoTopOffset()
        }
    }
    private applyStreamVideoTopOffset() {
        if (Math.abs(this.streamVideoTopOffsetPx) < 0.5) {
            document.documentElement.style.removeProperty("--stream-video-top")
            return
        }

        document.documentElement.style.setProperty("--stream-video-top", `calc(50% + ${this.streamVideoTopOffsetPx}px)`)
    }
    private updateKeyboardFloatingButtonPosition() {
        const screenKeyboard = this.sidebar.getScreenKeyboard()
        const visualViewport = window.visualViewport
        if (!screenKeyboard.isVisible() || !visualViewport) {
            this.resetKeyboardFloatingButtonPosition()
            return
        }

        const bottomInset = Math.min(16, visualViewport.height * 0.08)
        const buttonTop = visualViewport.offsetTop + visualViewport.height - bottomInset
        document.documentElement.style.setProperty("--stream-keyboard-button-top", `${buttonTop}px`)
    }
    private resetKeyboardFloatingButtonPosition() {
        document.documentElement.style.removeProperty("--stream-keyboard-button-top")
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
    }

    getStreamRect(): DOMRect {
        // The bounding rect of the videoElement or canvasElement can be bigger than the actual video
        // -> We need to correct for this when sending positions, else positions are wrong
        return this.stream.getVideoRenderer()?.getStreamRect() ?? new DOMRect()
    }
    getStream(): Stream | null {
        return this.stream
    }
}

/// Lightning fork: replaces the "connection info" dialog. Full screen with the app cover, the
/// three connection steps in plain words and, when it fails, the reason and what to do next.
/// The raw log stays one tap away under "Details".
class ConnectScreen implements Modal<void> {
    private app: ViewerApp

    private root = document.createElement("div")
    private backdrop = document.createElement("div")
    private cover = document.createElement("img")
    private title = document.createElement("h2")

    private steps = new Map<StreamStage, HTMLLIElement>()

    private problem = document.createElement("div")
    private problemTitle = document.createElement("h3")
    private problemText = document.createElement("p")

    private cancelButton: HTMLButtonElement
    private fullscreenButton: HTMLButtonElement
    private retryButton: HTMLButtonElement
    private exitButton: HTMLButtonElement
    private detailsButton = document.createElement("button")

    private log = document.createElement("pre")
    private logText = ""

    constructor(app: ViewerApp) {
        this.app = app

        this.root.classList.add("lt-connect")
        this.root.dataset.state = "connecting"

        this.backdrop.classList.add("lt-connect-backdrop")
        this.root.appendChild(this.backdrop)

        const card = document.createElement("div")
        card.classList.add("lt-connect-card")
        this.root.appendChild(card)

        this.cover.classList.add("lt-connect-cover")
        this.cover.alt = ""
        this.cover.hidden = true
        card.appendChild(this.cover)

        const body = document.createElement("div")
        body.classList.add("lt-connect-body")
        card.appendChild(body)

        const brand = document.createElement("p")
        brand.classList.add("lt-brand")
        brand.append(iconElement(ICON_BOLT), "Lightning")
        body.appendChild(brand)

        this.title.classList.add("lt-connect-title")
        this.title.innerText = I.stream.connecting
        body.appendChild(this.title)

        const steps = document.createElement("ol")
        steps.classList.add("lt-connect-steps")
        const labels: Array<[StreamStage, string]> = [
            ["network", I.stream.connectNetwork],
            ["starting", I.stream.connectStarting],
            ["video", I.stream.connectVideo],
        ]
        for (const [stage, label] of labels) {
            const item = document.createElement("li")
            item.dataset.state = "pending"

            const mark = document.createElement("span")
            mark.classList.add("lt-step-mark")
            mark.appendChild(iconElement(ICON_CHECK))

            const text = document.createElement("span")
            text.innerText = label

            item.append(mark, text)
            steps.appendChild(item)
            this.steps.set(stage, item)
        }
        body.appendChild(steps)

        this.problem.classList.add("lt-connect-problem")
        this.problem.hidden = true
        const problemText = document.createElement("div")
        problemText.append(this.problemTitle, this.problemText)
        this.problem.append(iconElement(ICON_ERROR), problemText)
        body.appendChild(this.problem)

        const actions = document.createElement("div")
        actions.classList.add("lt-connect-actions")

        this.cancelButton = iconButton(ICON_CLOSE, I.stream.cancel, "lt-button-ghost")
        this.cancelButton.addEventListener("click", () => this.app.exitStream())

        // Like the companion's: browsers on Android keep their bars until asked (a tap counts
        // as the permission the Fullscreen API needs), and it also locks the phone sideways
        this.fullscreenButton = iconButton(ICON_FULLSCREEN, I.stream.fullscreen, "lt-button-primary")
        this.fullscreenButton.addEventListener("click", () => this.app.requestFullscreen(false))
        document.addEventListener("fullscreenchange", () => this.updateActions())

        this.retryButton = iconButton(ICON_RETRY, I.stream.retry, "lt-button-primary")
        this.retryButton.addEventListener("click", () => location.reload())

        this.exitButton = iconButton(ICON_EXIT, I.stream.exit, "lt-button-ghost")
        this.exitButton.addEventListener("click", () => this.app.exitStream())

        this.detailsButton.type = "button"
        this.detailsButton.classList.add("lt-link")
        this.detailsButton.innerText = I.stream.details
        this.detailsButton.addEventListener("click", this.toggleLog.bind(this))

        actions.append(this.fullscreenButton, this.cancelButton, this.retryButton, this.exitButton, this.detailsButton)
        body.appendChild(actions)

        this.log.classList.add("lt-connect-log")
        this.log.hidden = true
        body.appendChild(this.log)

        this.updateActions()
    }

    setTitle(title: string) {
        this.title.innerText = title
    }
    setCover(url: string) {
        this.cover.src = url
        this.cover.hidden = false
        this.backdrop.style.backgroundImage = `url("${url}")`
    }

    private setStage(stage: StreamStage | "complete") {
        const order: Array<StreamStage> = ["network", "starting", "video"]
        const current = stage == "complete" ? order.length : order.indexOf(stage)

        order.forEach((step, index) => {
            const item = this.steps.get(step)
            if (item) {
                item.dataset.state = index < current ? "done" : index == current ? "active" : "pending"
            }
        })
    }

    private updateActions() {
        const connecting = this.root.dataset.state == "connecting"
        this.fullscreenButton.hidden = !(connecting && canUseFullscreen() && hasTouchScreen() && !this.app.isFullscreen())
        this.cancelButton.hidden = !connecting
        this.retryButton.hidden = connecting
        this.exitButton.hidden = connecting
    }

    showFailure(reason: StreamFailure) {
        // Leaving on purpose also closes the connection: not a failure worth showing
        if (this.app.isExiting()) {
            return
        }

        const ended = reason == "ended"
        this.root.dataset.state = ended ? "ended" : "failed"

        const messages: Record<StreamFailure, string> = {
            noDirectPath: I.stream.failNoDirectPath,
            codec: I.stream.failCodec,
            host: I.stream.failHost,
            timeout: I.stream.failTimeout,
            noVideo: I.stream.failNoVideo,
            ended: I.stream.endedHint,
            generic: I.stream.failGeneric,
        }
        this.problemTitle.innerText = ended ? I.stream.endedTitle : I.stream.failedTitle
        this.problemText.innerText = messages[reason]
        this.problem.hidden = false

        const retryLabel = this.retryButton.querySelector(".lt-button-label")
        if (retryLabel) {
            retryLabel.textContent = ended ? I.stream.reconnect : I.stream.retry
        }
        this.updateActions()

        setSidebarExtended(false)
        showModal(this)
    }

    private toggleLog() {
        this.log.hidden = !this.log.hidden
        this.log.innerText = this.logText
    }
    private addLog(line: string) {
        this.logText += `${line}\n`
        if (!this.log.hidden) {
            this.log.innerText = this.logText
        }
        console.info(`[Stream]: ${line}`)
    }

    onInfo(event: InfoEvent) {
        const data = event.detail

        if (data.type == "stage") {
            this.setStage(data.stage)
        } else if (data.type == "failure") {
            this.showFailure(data.reason)
        } else if (data.type == "connectionComplete") {
            this.setStage("complete")
            this.addLog(I.stream.connectionComplete)

            if (this.root.dataset.state == "connecting") {
                showModal(null)
            }
        } else if (data.type == "addDebugLine") {
            const message = data.line.trim()
            if (message) {
                this.addLog(message)
            }

            if (data.additional?.type == "informError") {
                showNotification(data.line)
            }
        }
    }

    onFinish(abort: AbortSignal): Promise<void> {
        // Stays until the stream connects (showModal(null)) or the player leaves
        return new Promise(() => { })
    }

    mount(parent: HTMLElement): void {
        parent.classList.add("modal-content-fullscreen")
        parent.appendChild(this.root)
    }
    unmount(parent: HTMLElement): void {
        parent.classList.remove("modal-content-fullscreen")
        parent.removeChild(this.root)
    }
}

/// Lightning fork: the upscaler picked in the in-game menu is also the one next streams start with.
function rememberUpscalingChoice(choice: UpscalingAlgorithm | "off") {
    try {
        const stored = JSON.parse(localStorage.getItem("mlSettings") ?? "{}")
        stored.upscaling = choice != "off"
        if (choice != "off") {
            stored.upscalingAlgorithm = choice
        }
        localStorage.setItem("mlSettings", JSON.stringify(stored))
    } catch {
        // Storage unavailable: only this stream changes
    }
}

/// The page can go fullscreen (not on iPhone Safari, whose home screen app already is).
function canUseFullscreen(): boolean {
    return !!(document.fullscreenEnabled || (document as any).webkitFullscreenEnabled)
        && typeof document.body?.requestFullscreen == "function"
}

function hasFinePointer(): boolean {
    return window.matchMedia("(any-pointer: fine)").matches
}
function hasTouchScreen(): boolean {
    return navigator.maxTouchPoints > 0 || window.matchMedia("(any-pointer: coarse)").matches
}

/// Lightning fork: a row of choices where the picked one is highlighted (radio buttons that
/// look like a pill switch). Easier to hit on a phone than a <select>.
class SegmentedChoice {
    readonly root = document.createElement("div")

    private buttons = new Map<string, HTMLButtonElement>()
    private value: string

    constructor(name: string, options: Array<{ value: string, name: string }>, selected: string, onChange: (value: string) => void) {
        this.root.classList.add("lt-segmented")
        this.root.dataset.name = name
        this.root.setAttribute("role", "radiogroup")
        this.value = selected

        for (const option of options) {
            const button = document.createElement("button")
            button.type = "button"
            button.dataset.value = option.value
            button.setAttribute("role", "radio")
            button.innerText = option.name
            button.addEventListener("click", () => {
                if (button.disabled || this.value == option.value) {
                    return
                }
                this.select(option.value)
                onChange(option.value)
            })

            this.buttons.set(option.value, button)
            this.root.appendChild(button)
        }

        this.select(selected)
    }

    private select(value: string) {
        this.value = value
        for (const [option, button] of this.buttons) {
            button.setAttribute("aria-checked", String(option == value))
            button.classList.toggle("lt-selected", option == value)
        }
    }

    getValue(): string {
        return this.value
    }
    setOptionEnabled(value: string, enabled: boolean) {
        const button = this.buttons.get(value)
        if (button) {
            button.disabled = !enabled
        }
    }
}

/// Lightning fork: the in-stream menu. A small floating button opens a panel with large,
/// labelled actions and the live options as segmented choices, instead of the sidebar list.
class ViewerSidebar implements Component, Sidebar {
    private app: ViewerApp

    private div = document.createElement("div")
    private title = document.createElement("h2")

    private statsButton: HTMLButtonElement

    private floatingKeyboardButton = document.createElement("button")
    private screenKeyboard = new ScreenKeyboard()

    private upscaling: SegmentedChoice
    private resolutionCaption = document.createElement("p")
    private touchMode: SegmentedChoice
    private mouseMode: SegmentedChoice

    constructor(app: ViewerApp) {
        this.app = app

        this.div.classList.add("sidebar-stream", "lt-menu")

        // Header: what is playing + close
        const header = document.createElement("div")
        header.classList.add("lt-menu-header")

        const brand = iconElement(ICON_BOLT)
        brand.classList.add("lt-menu-brand")

        this.title.classList.add("lt-menu-title")
        this.title.innerText = "Lightning"

        const close = document.createElement("button")
        close.type = "button"
        close.classList.add("lt-menu-close")
        close.title = I.stream.closeMenu
        close.ariaLabel = I.stream.closeMenu
        close.appendChild(iconElement(ICON_CLOSE))
        close.addEventListener("click", () => setSidebarExtended(false))

        header.append(brand, this.title, close)
        this.div.appendChild(header)

        // Actions
        const tiles = document.createElement("div")
        tiles.classList.add("lt-menu-tiles")
        this.div.appendChild(tiles)

        const keyboard = iconButton(ICON_KEYBOARD, I.stream.keyboard, "lt-tile")
        keyboard.addEventListener("click", () => {
            setSidebarExtended(false)
            this.screenKeyboard.show()
        })
        tiles.appendChild(keyboard)

        // iPhone Safari has no Fullscreen API for pages: the home screen app is already fullscreen
        if (document.fullscreenEnabled || (document as any).webkitFullscreenEnabled) {
            const fullscreen = iconButton(ICON_FULLSCREEN, I.stream.fullscreen, "lt-tile")
            fullscreen.addEventListener("click", async () => {
                if (this.app.isFullscreen()) {
                    this.app.markManualFullscreenExitRequested()
                    await this.app.exitFullscreen()
                } else {
                    await this.app.requestFullscreen()
                }
            })
            tiles.appendChild(fullscreen)
        }

        if (hasFinePointer()) {
            const lockMouse = iconButton(ICON_MOUSE, I.stream.lockMouse, "lt-tile")
            lockMouse.addEventListener("click", async () => {
                await this.app.requestPointerLock(true)
            })
            tiles.appendChild(lockMouse)
        }

        this.statsButton = iconButton(ICON_STATS, I.stream.stats, "lt-tile")
        this.statsButton.addEventListener("click", () => {
            const stats = this.app.getStream()?.getStats()
            if (stats) {
                stats.toggle()
                this.statsButton.classList.toggle("lt-active", stats.isEnabled())
            }
        })
        tiles.appendChild(this.statsButton)

        const sendKey = iconButton(ICON_SEND_KEY, I.stream.sendKey, "lt-tile")
        sendKey.addEventListener("click", async () => {
            const key = await showModal(new SendKeycodeModal())

            if (key == null) {
                return
            }

            this.app.getStream()?.getInput().sendKey(true, key, emptyKeyModifiers())
            this.app.getStream()?.getInput().sendKey(false, key, emptyKeyModifiers())
        })
        tiles.appendChild(sendKey)

        const exit = iconButton(ICON_EXIT, I.stream.exit, "lt-tile", "lt-danger")
        exit.addEventListener("click", () => this.app.exitStream())
        tiles.appendChild(exit)

        // Screen keyboard
        this.floatingKeyboardButton.innerText = "⌨×"
        this.floatingKeyboardButton.title = I.stream.hideKeyboard
        this.floatingKeyboardButton.ariaLabel = I.stream.hideKeyboard
        this.floatingKeyboardButton.classList.add("stream-keyboard-floating-button")
        this.floatingKeyboardButton.addEventListener("click", event => {
            event.preventDefault()
            event.stopPropagation()
            this.screenKeyboard.hide()
        })
        stopPropagationOn(this.floatingKeyboardButton)
        this.screenKeyboard.addKeyDownListener(this.onKeyDown.bind(this))
        this.screenKeyboard.addKeyUpListener(this.onKeyUp.bind(this))
        this.screenKeyboard.addTextListener(this.onText.bind(this))
        this.screenKeyboard.addKeyboardModeWillChangeListener(this.app.onScreenKeyboardModeWillChange.bind(this.app))
        this.screenKeyboard.addKeyboardModeListener(this.onKeyboardModeChange.bind(this))
        // Mounted on the page body (see mount): keep its keys from also reaching the stream's
        // own document listeners, as the sidebar root used to
        stopPropagationOn(this.screenKeyboard.getHiddenElement())

        // Upscaling, switched live to compare on the device
        this.upscaling = new SegmentedChoice("upscaling", [
            { value: "off", name: I.stream.upscalingOff },
            { value: "auto", name: I.stream.upscalingAutoShort },
            { value: "fsr1", name: "FSR 1" },
            { value: "nis", name: "NIS" },
            { value: "sgsr", name: "SGSR" },
            { value: "sharpen", name: I.settings.upscalingSharpenOnly },
        ], this.app.upscalingChoice, this.onUpscalingChange.bind(this))
        const imageSection = this.addSection(I.stream.sectionImage, this.upscaling)
        this.resolutionCaption.classList.add("lt-menu-caption")
        imageSection.appendChild(this.resolutionCaption)

        // Touch and mouse: only the ones this device has
        this.touchMode = new SegmentedChoice("touchMode", [
            { value: "touch", name: I.stream.touch },
            { value: "mouseRelative", name: I.stream.touchpad },
            { value: "localCursor", name: I.stream.localCursor },
            { value: "pointAndDrag", name: I.stream.pointAndDrag }
        ], this.app.getInputConfig().touchMode, this.onTouchModeChange.bind(this))
        if (hasTouchScreen()) {
            this.addSection(I.stream.sectionTouch, this.touchMode)
        }

        this.mouseMode = new SegmentedChoice("mouseMode", [
            { value: "relative", name: I.stream.relative },
            { value: "follow", name: I.stream.follow },
            { value: "localCursor", name: I.stream.localCursor },
            { value: "pointAndDrag", name: I.stream.pointAndDrag }
        ], this.app.getInputConfig().mouseMode, this.onMouseModeChange.bind(this))
        if (hasFinePointer()) {
            this.addSection(I.stream.sectionMouse, this.mouseMode)
        }
    }

    private addSection(title: string, choice: SegmentedChoice): HTMLElement {
        const section = document.createElement("section")
        section.classList.add("lt-menu-section")

        const header = document.createElement("h3")
        header.innerText = title

        section.append(header, choice.root)
        this.div.appendChild(section)
        return section
    }

    // -- Upscaling
    /// Turning upscaling on/off may change what the PC has to render (virtual display): then the
    /// stream restarts at the new resolution. Switching between upscalers is always live.
    private async onUpscalingChange(value: string) {
        const choice = value as UpscalingAlgorithm | "off"
        const stream = this.app.getStream()
        if (!stream) {
            return
        }

        rememberUpscalingChoice(choice)

        if (await stream.upscalingNeedsReconnect(choice != "off")) {
            this.app.reconnectWithUpscaling(choice)
            return
        }
        stream.setUpscaling(choice)
        this.updateResolutionCaption()
    }
    /// "PC 1920×1080 → 2556×1179 · H.265": what the PC renders, what this screen shows, and
    /// the codec in between.
    private updateResolutionCaption() {
        const stream = this.app.getStream()
        if (!stream) {
            return
        }
        const [width, height] = stream.getStreamerSize()
        const upscaler = stream.getUpscalerStats()
        const [screenWidth, screenHeight] = upscaler ? upscaler.output : physicalScreenSize()
        const codec = stream.getVideoCodec()
        this.resolutionCaption.innerText = `PC ${width}×${height} → ${screenWidth}×${screenHeight}`
            + (codec ? ` · ${codecDisplayName(codec)}` : "")
    }

    setTitle(title: string) {
        this.title.innerText = title
    }

    onCapabilitiesChange(capabilities: StreamCapabilities) {
        this.touchMode.setOptionEnabled("touch", capabilities.touch)
    }

    getScreenKeyboard(): ScreenKeyboard {
        return this.screenKeyboard
    }

    // -- Keyboard
    private onText(event: TextEvent) {
        this.app.getStream()?.getInput().sendText(event.detail.text)
    }
    private onKeyDown(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyDown(event)
    }
    private onKeyUp(event: KeyboardEvent) {
        this.app.getStream()?.getInput().onKeyUp(event)
    }
    private onKeyboardModeChange(event: KeyboardModeEvent) {
        if (event.detail.enabled) {
            this.floatingKeyboardButton.classList.add("visible")
        } else {
            this.floatingKeyboardButton.classList.remove("visible")
            this.app.resetKeyboardViewportVideoOffset()
        }
    }

    // -- Mouse Mode
    private onMouseModeChange(value: string) {
        const config = this.app.getInputConfig()
        config.mouseMode = value as MouseMode
        this.app.setInputConfig(config)
    }

    // -- Touch Mode
    private onTouchModeChange(value: string) {
        const config = this.app.getInputConfig()
        config.touchMode = value as any
        this.app.setInputConfig(config)
    }

    extended(): void {
        this.updateResolutionCaption()
    }
    unextend(): void {

    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.div)
        const appRoot = document.getElementById("root")
            ; (appRoot ?? document.body).appendChild(this.floatingKeyboardButton)
        // Lightning fork: the field that holds the phone keyboard lives outside the menu panel.
        // Inside it, hiding the panel (visibility) took the focus away and iOS closed the
        // keyboard right after opening it.
        document.body.appendChild(this.screenKeyboard.getHiddenElement())
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.div)
        if (this.floatingKeyboardButton.parentElement) {
            this.floatingKeyboardButton.parentElement.removeChild(this.floatingKeyboardButton)
        }
        this.screenKeyboard.getHiddenElement().remove()
    }
}


class SendKeycodeModal extends FormModal<number> {

    private dropdownSearch: SelectComponent

    constructor() {
        super()

        const keyList = []
        for (const keyNameRaw in StreamKeys) {
            const keyName = keyNameRaw as keyof typeof StreamKeys
            const keyValue = StreamKeys[keyName]

            const PREFIX = "VK_"

            let name: string = keyName
            if (name.startsWith(PREFIX)) {
                name = name.slice(PREFIX.length)
            }

            keyList.push({
                value: keyValue.toString(),
                name
            })
        }

        this.dropdownSearch = new SelectComponent("winKeycode", keyList, {
            hasSearch: true,
            displayName: I.stream.selectKeycode
        })
    }

    mountForm(form: HTMLFormElement): void {
        this.dropdownSearch.mount(form)
    }


    reset(): void {
        this.dropdownSearch.reset()
    }

    submit(): number | null {
        const keyString = this.dropdownSearch.getValue()
        if (keyString == null) {
            return null
        }

        return parseInt(keyString)
    }
}

// Stop propagation so the stream doesn't get it
function stopPropagationOn(element: HTMLElement) {
    element.addEventListener("keydown", onStopPropagation)
    element.addEventListener("keyup", onStopPropagation)
    element.addEventListener("keypress", onStopPropagation)
    element.addEventListener("click", onStopPropagation)
    element.addEventListener("mousedown", onStopPropagation)
    element.addEventListener("mouseup", onStopPropagation)
    element.addEventListener("mousemove", onStopPropagation)
    element.addEventListener("wheel", onStopPropagation)
    element.addEventListener("contextmenu", onStopPropagation)
    element.addEventListener("touchstart", onStopPropagation)
    element.addEventListener("touchmove", onStopPropagation)
    element.addEventListener("touchend", onStopPropagation)
    element.addEventListener("touchcancel", onStopPropagation)
}
function onStopPropagation(event: Event) {
    event.stopPropagation()
}
