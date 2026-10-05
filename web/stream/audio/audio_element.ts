import { globalObject } from "../../util"
import { Pipe, PipeInfo } from "../pipeline/index"
import { addPipePassthrough } from "../pipeline/pipes"
import { AudioPlayerSetup, TrackAudioPlayer } from "./index"

export class AudioElementPlayer implements TrackAudioPlayer {
    static readonly pipeName = "AudioElementPlayer"

    static readonly type = "audiotrack"

    static async getInfo(): Promise<PipeInfo> {
        return {
            environmentSupported: "HTMLAudioElement" in globalObject() && "srcObject" in HTMLAudioElement.prototype,
        }
    }

    readonly implementationName: string = "audio_element"

    private audioElement = document.createElement("audio")
    private oldTrack: MediaStreamTrack | null = null
    private stream = new MediaStream()

    // Lightning fork: the browser may refuse sound until a tap (autoplay policy). Then we play
    // muted, show a hint and unmute on the next tap. A gamepad press does not count as a tap.
    private wantsSound = false
    private hint = document.createElement("div")
    private wasHidden = false
    private onPageBack = () => {
        if (document.visibilityState != "visible") {
            this.wasHidden = true
        } else if (this.wasHidden) {
            this.wasHidden = false
            this.revive()
        } else if (this.oldTrack && this.audioElement.paused) {
            this.startPlaying()
        }
    }
    private onPageHide = () => { this.wasHidden = true }

    constructor() {
        this.implementationName = "audio_element"

        this.audioElement.classList.add("audio-stream")
        this.audioElement.preload = "none"
        this.audioElement.controls = false
        this.audioElement.autoplay = true
        this.audioElement.muted = true
        this.audioElement.srcObject = this.stream
        this.audioElement.addEventListener("playing", () => {
            if (!this.audioElement.muted) this.hint.classList.remove("lt-visible")
        })

        this.hint.className = "lt-audio-hint"
        this.hint.textContent = (navigator.language || "").toLowerCase().startsWith("pt")
            ? "🔇 Toque na tela para ativar o som" : "🔇 Tap the screen to turn on sound"

        // iOS/Android pause or silence the element while the app is in the background, and
        // nothing resumes it on return -> the stream came back with no sound
        document.addEventListener("visibilitychange", this.onPageBack)
        window.addEventListener("pagehide", this.onPageHide)
        window.addEventListener("pageshow", this.onPageBack)
        window.addEventListener("focus", this.onPageBack)

        addPipePassthrough(this)
    }

    setup(_setup: AudioPlayerSetup) {
        return true
    }
    cleanup(): void {
        if (this.oldTrack) {
            this.stream.removeTrack(this.oldTrack)
            this.oldTrack = null
        }
        this.audioElement.srcObject = null
        document.removeEventListener("visibilitychange", this.onPageBack)
        window.removeEventListener("pagehide", this.onPageHide)
        window.removeEventListener("pageshow", this.onPageBack)
        window.removeEventListener("focus", this.onPageBack)
        this.hint.remove()
    }

    setTrack(track: MediaStreamTrack): void {
        if (this.oldTrack) {
            this.stream.removeTrack(this.oldTrack)
            this.oldTrack = null
        }

        this.stream.addTrack(track)
        this.oldTrack = track

        // Try with sound right away: entering with a gamepad would otherwise stay muted forever
        this.wantsSound = true
        this.startPlaying()
    }

    private playAttempt = 0
    private startPlaying() {
        // Answers of an older attempt arrive late and must not undo a newer one
        const attempt = ++this.playAttempt
        this.audioElement.muted = false
        this.audioElement.play().then(() => {
            if (attempt == this.playAttempt) this.hint.classList.remove("lt-visible")
        }).catch((e: any) => {
            if (attempt != this.playAttempt || e?.name != "NotAllowedError") return
            // Not allowed without a tap: keep the track flowing muted and ask for a tap
            this.audioElement.muted = true
            this.audioElement.play().catch(() => { })
            if (this.wantsSound) this.hint.classList.add("lt-visible")
        })
    }

    private revive() {
        if (!this.oldTrack) return
        // After the background, Safari can keep the element "playing" but silent until the
        // source is set again
        this.audioElement.srcObject = null
        this.audioElement.srcObject = this.stream
        this.startPlaying()
    }

    onUserInteraction(): void {
        this.wantsSound = true
        if (this.audioElement.paused || this.audioElement.muted) {
            // A tap unlocks sound: hide the hint now (it comes back if the browser still refuses)
            this.hint.classList.remove("lt-visible")
            this.startPlaying()
        }
    }

    mount(parent: HTMLElement): void {
        parent.appendChild(this.audioElement)
        parent.appendChild(this.hint)
    }
    unmount(parent: HTMLElement): void {
        parent.removeChild(this.audioElement)
        this.hint.remove()
    }

    getBase(): Pipe | null {
        return null
    }
}
