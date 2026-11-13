import { describe, expect, it } from 'vitest'
import { formatClock, kmWarmupLabel } from './phisonKmRag'

const strings = {
  KM_WARMUP_ANALYZING: 'Analyzing documents…',
  KM_WARMUP_WARMING: 'Pre-reading document {current}/{total}',
  KM_WARMUP_REMAINING: 'about {time} left',
  KM_WARMUP_ELAPSED: '{time} elapsed',
}

describe('kmWarmupLabel', () => {
  it('counts down from the estimate while warming', () => {
    const label = kmWarmupLabel(
      { phase: 'warming', current: 1, total: 2, estimateMs: 150_000, since: 0 },
      30_000,
      strings,
    )
    expect(label).toBe('Pre-reading document 1/2 · about 2:00 left')
  })

  it('shows elapsed time until a speed is known', () => {
    expect(kmWarmupLabel({ phase: 'analyzing', since: 1_000 }, 66_000, strings)).toBe(
      'Analyzing documents… · 1:05 elapsed',
    )
  })

  it('never counts below zero', () => {
    expect(formatClock(-4_000)).toBe('0:00')
  })
})
