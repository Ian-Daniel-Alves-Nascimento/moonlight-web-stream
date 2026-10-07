import { Settings } from "./component/settings_menu"

const trueDefaultSettings: Settings =

{
    // possible values: "left", "right", "up", "down"
    "sidebarEdge": "left",
    "hideSidebarButton": false,
    "bitrate": 10000,
    "fps": 60,
    // possible values: "auto", "full", "safe", "720p", "1080p", "1440p", "4k", "custom"
    // (Lightning fork: "auto" = the monitor's resolution with a physical monitor, this screen's
    // with a virtual display)
    "videoSize": "auto",
    // only works if videoSize=custom
    "videoSizeCustom": {
        "width": 1920,
        "height": 1080
    },
    // Lightning fork: render less on the host and upscale on this device (off = original behavior)
    "upscaling": false,
    // possible values: "auto" (half the screen, at least 720p), "75", "67", "50" (percent)
    "upscalingRenderScale": "auto",
    // possible values: "auto" (the best level this device keeps up with, FSR 1 at most), "fsr1" (quality),
    // "nis" (balanced), "sgsr" (performance), "sharpen" (sharpening only)
    "upscalingAlgorithm": "auto",
    // possible values: "h264", "h265", "av1", "auto" (Lightning fork: the best one this device
    // decodes in hardware, H.264 otherwise; see stream/codec.ts)
    "videoCodec": "auto",
    "forceVideoElementRenderer": false,
    "canvasRenderer": false,
    // Canvas only: when true, draw only on requestAnimationFrame (stable, may add ~0–17 ms). When false, draw on frame submit (low latency).
    "canvasVsync": false,
    "playAudioLocal": false,
    // possible values: "highres", "normal"
    "mouseScrollMode": "highres",
    // possible values: "relative", "follow", "pointAndDrag"
    "mouseMode": "follow",
    // possible values: "touch", "mouseRelative", "localCursor", "pointAndDrag"
    "touchMode": "mouseRelative",
    "localCursorSensitivity": 1,
    "controllerConfig": {
        "invertAB": false,
        "invertXY": false,
        // possible values: null or a number, example: 60, 120
        "sendIntervalOverride": null
    },
    // Lightning fork: on-screen controller. possible values: "auto" (phones and tablets, while no
    // real controller is connected), "always", "off"
    "touchGamepad": "auto",
    // possible values: "standard", "action", "retro", "racing"
    "touchGamepadLayout": "standard",
    // percent
    "touchGamepadSize": 100,
    // percent: how visible the controls are while idle
    "touchGamepadOpacity": 60,
    // possible values: "stick", "touchpad" (standard layout's right side)
    "touchGamepadLook": "stick",
    "touchGamepadLookSensitivity": 1,
    "touchGamepadHaptics": true,
    "touchGamepadSprintAtEdge": false,
    // possible values: "auto", "webrtc", "websocket" (Lightning fork: "auto" = WebRTC only)
    "dataTransport": "auto",
    // "auto" follows the device language (Lightning fork)
    "language": "auto",
    "enterFullscreenOnStreamStart": false,
    "toggleFullscreenWithKeybind": false,
    // possible values: "standard", "old"
    "pageStyle": "standard",
    "hdr": false,
    // Lightning fork: HDR highlights on an HDR screen over an SDR stream. possible values:
    // "off", "low", "medium", "high" (only where the screen and the browser can show HDR)
    "autoHdr": "medium",
    "useSelectElementPolyfill": false
}

export default trueDefaultSettings as Settings
