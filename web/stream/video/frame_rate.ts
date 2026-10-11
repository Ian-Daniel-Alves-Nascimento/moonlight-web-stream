/*
 * Frame rate drawn by the page vs the video's, for the Lightning fork of Moonlight Web.
 *
 * What draws the picture on a canvas (Auto HDR, the picture cleanup) runs once per video frame
 * callback, and the browser may call it less often than the video has frames: iPhone Safari
 * updates pages at most ~60 times a second by default ("Prefer Page Rendering Updates near
 * 60fps"), while it shows the plain <video> at 120. Nothing on the page can lift that, so the
 * player warns that the feature limits the picture to that rate.
 *
 * Copyright (c) 2026 the author of Lightning Launcher (github.com/Ian-Daniel-Alves-Nascimento).
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 */

/// Drawing fewer than this share of the video's frames counts as limited
const LIMITED_SHARE = 0.85
/// Consecutive one-second windows that must be limited before saying so
const LIMITED_WINDOWS = 3

export class FrameRateMeter {
    /// Frames per second the video decodes, and how many callbacks the page got
    videoFps = 0
    drawnFps = 0
    /// Video frames decoded so far, from the connection: Safari's <video> doesn't count the
    /// frames of a WebRTC stream (getVideoPlaybackQuality says 0)
    framesDecoded: (() => Promise<number | null>) | null = null
    /// Called once, when the page has been drawing fewer frames than the video for a while
    onLimited: ((drawnFps: number, videoFps: number) => void) | null = null

    private start = 0
    private decodedAtStart = 0
    private drawn = 0
    private fromSource: number | null = null
    private sourceBusy = false
    private limitedWindows = 0
    private limitedReported = false

    constructor(private video: HTMLVideoElement) { }

    /// The page drew limited for a while (and still does)
    isLimited(): boolean {
        return this.limitedWindows >= LIMITED_WINDOWS
    }

    /// Once per video frame callback.
    tick(now: number) {
        this.drawn++
        if (this.start == 0) {
            this.start = now
            this.decodedAtStart = this.decodedFrames()
            this.drawn = 0
            return
        }
        const elapsed = now - this.start
        if (elapsed < 1000) {
            return
        }
        const decoded = this.decodedFrames()
        if (elapsed < 3000 && decoded > 0 && this.decodedAtStart > 0 && decoded >= this.decodedAtStart) {
            const videoFps = (decoded - this.decodedAtStart) * 1000 / elapsed
            const drawnFps = this.drawn * 1000 / elapsed
            // Smoothed; a pause (background, network stall) is skipped instead of counted
            this.videoFps = this.videoFps == 0 ? videoFps : this.videoFps * 0.7 + videoFps * 0.3
            this.drawnFps = this.drawnFps == 0 ? drawnFps : this.drawnFps * 0.7 + drawnFps * 0.3
            // A network stall drops both rates alike: only the drawn one lagging counts
            this.limitedWindows = this.videoFps > 0 && this.drawnFps < this.videoFps * LIMITED_SHARE ? this.limitedWindows + 1 : 0
            if (this.isLimited() && !this.limitedReported) {
                this.limitedReported = true
                this.onLimited?.(this.drawnFps, this.videoFps)
            }
        }
        this.start = now
        this.decodedAtStart = decoded
        this.drawn = 0
    }

    /// The <video>'s own count, or else the connection's (read in the background, about once a
    /// second, so it lags a little: both ends of a window lag alike)
    private decodedFrames(): number {
        const own = this.video.getVideoPlaybackQuality?.().totalVideoFrames ?? 0
        if (own > 0 || !this.framesDecoded) {
            return own
        }
        if (!this.sourceBusy) {
            this.sourceBusy = true
            this.framesDecoded().then(frames => {
                this.fromSource = frames
            }, () => { }).finally(() => {
                this.sourceBusy = false
            })
        }
        return this.fromSource ?? 0
    }
}
