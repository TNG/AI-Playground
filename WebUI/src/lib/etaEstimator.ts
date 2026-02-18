/**
 * ETA Estimator - calculates time remaining based on progress over time
 */
export class EtaEstimator {
  private lastValue: number
  private lastTime: number
  private readonly maxValue: number

  constructor(maxValue = 100) {
    this.maxValue = maxValue
    this.lastValue = 0
    this.lastTime = 0
  }

  /**
   * Reset the estimator state
   */
  reset(): void {
    this.lastValue = 0
    this.lastTime = 0
  }

  /**
   * Update with current progress and get ETA in seconds
   * @param currentValue Current progress value
   * @returns ETA in seconds, or null if not enough data
   */
  update(currentValue: number): number | null {
    const now = Date.now()

    if (this.lastTime === 0) {
      this.lastValue = currentValue
      this.lastTime = now
      return null
    }

    if (currentValue <= this.lastValue) {
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

    const valuePerSecond = valueChange / timeElapsedSeconds
    const remainingValue = this.maxValue - currentValue

    return remainingValue / valuePerSecond
  }

  updateAndEstimate(currentValue: number): string {
    const etaSeconds = this.update(currentValue)
    return this.formatTime(etaSeconds)
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
