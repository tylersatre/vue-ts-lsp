import { describe, it, expect, vi, afterEach } from 'vitest'
import { RetryTracker } from '@src/recovery.js'

describe('RetryTracker', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('allows the first restart', () => {
        const tracker = new RetryTracker(3, 30_000)
        expect(tracker.canRestart()).toBe(true)
    })

    it('allows up to maxRestarts within the window', () => {
        const tracker = new RetryTracker(3, 30_000)
        expect(tracker.canRestart()).toBe(true)
        expect(tracker.canRestart()).toBe(true)
        expect(tracker.canRestart()).toBe(true)
    })

    it('rejects the (maxRestarts+1)th restart within the window', () => {
        const tracker = new RetryTracker(3, 30_000)
        tracker.canRestart()
        tracker.canRestart()
        tracker.canRestart()
        expect(tracker.canRestart()).toBe(false)
    })

    it('restartCount reflects allowed attempts', () => {
        const tracker = new RetryTracker(3, 30_000)
        expect(tracker.restartCount).toBe(0)
        tracker.canRestart()
        expect(tracker.restartCount).toBe(1)
        tracker.canRestart()
        expect(tracker.restartCount).toBe(2)
    })

    it('restartCount does not increment when cap is exceeded', () => {
        const tracker = new RetryTracker(2, 30_000)
        tracker.canRestart()
        tracker.canRestart()
        expect(tracker.canRestart()).toBe(false)
        expect(tracker.restartCount).toBe(2)
    })

    it('allows restarts again after the window expires', () => {
        vi.useFakeTimers()
        const tracker = new RetryTracker(3, 30_000)

        tracker.canRestart()
        tracker.canRestart()
        tracker.canRestart()
        expect(tracker.canRestart()).toBe(false)

        vi.advanceTimersByTime(30_001)

        expect(tracker.canRestart()).toBe(true)
    })

    it('slides the window correctly — old entries expire one by one', () => {
        vi.useFakeTimers()
        const tracker = new RetryTracker(3, 10_000)

        tracker.canRestart()
        vi.advanceTimersByTime(5_000)
        tracker.canRestart()
        vi.advanceTimersByTime(5_000)
        tracker.canRestart()

        vi.advanceTimersByTime(1)
        expect(tracker.canRestart()).toBe(true)
    })

    it('uses custom maxRestarts and windowMs', () => {
        const tracker = new RetryTracker(1, 5_000)
        expect(tracker.canRestart()).toBe(true)
        expect(tracker.canRestart()).toBe(false)
        expect(tracker.maxRestarts).toBe(1)
        expect(tracker.windowMs).toBe(5_000)
    })
})
