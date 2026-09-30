/*
 * Quality governor for the client-side upscaler (Lightning fork).
 *
 * Idea from the EnhancerGovernor of MoonlightWeb by Bruno Martin (GPL-3.0-or-later): the
 * budget is the time between two video frames. When the upscaling passes don't fit in it, go
 * one level down (FSR 1 → NIS → SGSR → sharpening only → off); climb back carefully, doubling
 * the wait after every climb that didn't hold.
 *
 * Pure logic, no WebGL: the upscaler feeds one sample per video frame.
 *
 * This program is free software: you can redistribute it and/or modify it under the terms of
 * the GNU General Public License as published by the Free Software Foundation, either version 3
 * of the License, or (at your option) any later version.
 */

export type UpscalingLevel = "fsr1" | "nis" | "sgsr" | "sharpen" | "off"

/// From the most expensive to nothing at all.
export const UPSCALING_LEVELS: ReadonlyArray<UpscalingLevel> = ["fsr1", "nis", "sgsr", "sharpen", "off"]

export type GovernorSample = {
    /// The previous frame's passes weren't finished on the GPU when this frame arrived.
    late: boolean
    /// GPU time of the passes, when the browser can measure it.
    gpuMs: number | null
    /// Time between video frames (the budget).
    budgetMs: number
}

/// Frames looked at for a decision (~1.5 s at 60 fps) and the least needed after a change.
const WINDOW = 90
const MIN_SAMPLES = 45
/// Too slow: this share of late frames, or the GPU time above this share of the budget.
const OVERLOAD_LATE = 0.15
const OVERLOAD_GPU = 0.8
/// Comfortable enough to try the level above.
const COMFORT_LATE = 0.02
const COMFORT_GPU = 0.5
/// Wait before climbing, doubled after each climb that had to come back down.
const CLIMB_WAIT_START_MS = 10_000
const CLIMB_WAIT_MAX_MS = 160_000
/// A climb that holds this long counts as a success.
const CLIMB_TRIAL_MS = 4_000

export class UpscalingGovernor {
    private levelIndex: number
    private samples: Array<GovernorSample> = []
    private lastChange: number
    private climbWait = CLIMB_WAIT_START_MS
    private climbTrialSince: number | null = null

    /// Why the level last changed (for the stats line).
    lastReason = ""

    /// `available` says whether a level can run now (NIS only works up to 2×, a shader may
    /// have failed to build); `ceiling` is the best level allowed, `start` where to begin.
    constructor(
        private available: (level: UpscalingLevel) => boolean,
        start: UpscalingLevel,
        now: number,
        private ceiling: UpscalingLevel = "fsr1",
    ) {
        this.levelIndex = Math.max(UPSCALING_LEVELS.indexOf(start), UPSCALING_LEVELS.indexOf(ceiling))
        if (!this.available(this.level)) {
            this.levelIndex = this.nextDown(this.levelIndex)
        }
        this.lastChange = now
    }

    get level(): UpscalingLevel {
        return UPSCALING_LEVELS[this.levelIndex]
    }

    /// Returns the new level when it changes, otherwise null.
    onFrame(sample: GovernorSample, now: number): UpscalingLevel | null {
        this.samples.push(sample)
        if (this.samples.length > WINDOW) {
            this.samples.shift()
        }
        if (this.samples.length < MIN_SAMPLES) {
            return null
        }

        const late = this.samples.filter(sample => sample.late).length / this.samples.length
        const measured = this.samples.filter(sample => sample.gpuMs != null)
        const gpuShare = measured.length > 0
            ? measured.reduce((sum, sample) => sum + sample.gpuMs! / sample.budgetMs, 0) / measured.length
            : null

        const overloaded = late > OVERLOAD_LATE || (gpuShare != null && gpuShare > OVERLOAD_GPU)
        const comfortable = late < COMFORT_LATE && (gpuShare == null || gpuShare < COMFORT_GPU)
        const detail = `${Math.round(late * 100)}% late` + (gpuShare != null ? `, GPU ${Math.round(gpuShare * 100)}% of the frame` : "")

        if (overloaded && this.level != "off") {
            if (this.climbTrialSince != null) {
                // The climb didn't hold: wait longer before the next one
                this.climbWait = Math.min(this.climbWait * 2, CLIMB_WAIT_MAX_MS)
                this.climbTrialSince = null
            }
            return this.change(this.nextDown(this.levelIndex), now, `down: ${detail}`)
        }

        if (this.climbTrialSince != null && now - this.climbTrialSince >= CLIMB_TRIAL_MS) {
            this.climbTrialSince = null
            this.climbWait = CLIMB_WAIT_START_MS
        }

        const ceilingIndex = UPSCALING_LEVELS.indexOf(this.ceiling)
        if (comfortable && this.levelIndex > ceilingIndex && now - this.lastChange >= this.climbWait) {
            const up = this.nextUp(this.levelIndex, ceilingIndex)
            if (up != this.levelIndex) {
                this.climbTrialSince = now
                return this.change(up, now, `up (trying): ${detail}`)
            }
        }

        return null
    }

    private change(index: number, now: number, reason: string): UpscalingLevel | null {
        if (index == this.levelIndex) {
            return null
        }
        this.levelIndex = index
        this.lastChange = now
        this.samples = []
        this.lastReason = reason
        return this.level
    }

    private nextDown(index: number): number {
        for (let next = index + 1; next < UPSCALING_LEVELS.length; next++) {
            if (this.available(UPSCALING_LEVELS[next])) {
                return next
            }
        }
        return UPSCALING_LEVELS.length - 1
    }
    private nextUp(index: number, ceilingIndex: number): number {
        for (let next = index - 1; next >= ceilingIndex; next--) {
            if (this.available(UPSCALING_LEVELS[next])) {
                return next
            }
        }
        return index
    }
}
