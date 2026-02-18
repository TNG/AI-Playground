type RateSample = {
  timestamp: number
  rate: number // value per second
}

/**
 * ETA Estimator - calculates time remaining based on progress over time
 * Uses a rolling window of rate samples with median for smoothing
 */
export class EtaEstimator {
  private samples: RateSample[]
  private lastValue: number
  private lastTime: number
  private readonly maxValue: number
  private readonly windowMs: number
  private readonly enoughDataMs: number

  constructor(maxValue = 100, windowSeconds = 30, enoughDataSeconds = 5) {
    this.samples = []
    this.lastValue = 0
    this.lastTime = 0
    this.maxValue = maxValue
    this.windowMs = windowSeconds * 1000
    this.enoughDataMs = enoughDataSeconds * 1000
  }

  reset(): void {
    this.samples = []
    this.lastValue = 0
    this.lastTime = 0
  }

  update(currentValue: number): number | null {
    const now = Date.now()

    if (this.lastTime === 0) {
      this.lastValue = currentValue
      this.lastTime = now
      return null
    }

    if (currentValue <= this.lastValue) {
      this.reset()
      this.lastValue = currentValue
      this.lastTime = now
      return null
    }

    const valueChange = currentValue - this.lastValue
    const timeElapsedSeconds = (now - this.lastTime) / 1000

    this.lastValue = currentValue
    this.lastTime = now

    if (timeElapsedSeconds <= 0 || valueChange <= 0) {
      return null
    }

    this.addSample(now, valueChange / timeElapsedSeconds)
    this.pruneOldSamples(now)

    const medianRate = this.calculateMedianRate()
    if (medianRate === null) {
      return null
    }

    const remainingValue = this.maxValue - currentValue
    return remainingValue / medianRate
  }

  updateAndEstimate(currentValue: number): string {
    const etaSeconds = this.update(currentValue)

    if (!this.hasEnoughData()) {
      return '--'
    }

    return this.formatTime(etaSeconds)
  }

  private addSample(timestamp: number, rate: number): void {
    this.samples.push({ timestamp, rate })
  }

  private pruneOldSamples(now: number): void {
    const cutoff = now - this.windowMs
    this.samples = this.samples.filter((s) => s.timestamp >= cutoff)
  }

  private hasEnoughData(): boolean {
    if (this.samples.length < 2) {
      return false
    }
    const oldestTimestamp = this.samples[0].timestamp
    const newestTimestamp = this.samples[this.samples.length - 1].timestamp
    return newestTimestamp - oldestTimestamp >= this.enoughDataMs
  }

  private calculateMedianRate(): number | null {
    if (this.samples.length === 0) {
      return null
    }

    const sortedRates = this.samples.map((s) => s.rate).sort((a, b) => a - b)
    const mid = Math.floor(sortedRates.length / 2)

    if (sortedRates.length % 2 === 0) {
      return (sortedRates[mid - 1] + sortedRates[mid]) / 2
    }
    return sortedRates[mid]
  }

  private formatTime(seconds: number | null): string {
    if (seconds === null || !isFinite(seconds) || seconds < 0) {
      return '--'
    }

    if (seconds < 60) {
      return `${Math.round(seconds)}s`
    }

    if (seconds < 3600) {
      const mins = Math.floor(seconds / 60)
      const secs = Math.round(seconds % 60)
      return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
    }

    const hours = Math.floor(seconds / 3600)
    const mins = Math.round((seconds % 3600) / 60)
    return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
  }
}
