export class RetryTracker {
    private readonly timestamps: number[] = []

    constructor(
        readonly maxRestarts: number = 3,
        readonly windowMs: number = 30_000
    ) {}

    canRestart(): boolean {
        const now = Date.now()
        while (this.timestamps.length > 0 && now - this.timestamps[0]! > this.windowMs) {
            this.timestamps.shift()
        }
        if (this.timestamps.length >= this.maxRestarts) {
            return false
        }
        this.timestamps.push(now)
        return true
    }

    get restartCount(): number {
        return this.timestamps.length
    }
}
