import { describe, expect, it } from 'vitest'
import { reasoningTimingKey, trackReasoningTimings, type ReasoningTiming } from './reasoningTimings'

function reasoning(state: 'streaming' | 'done') {
  return { type: 'reasoning', state }
}

describe('trackReasoningTimings', () => {
  it('times a block from the first streaming update to its last', () => {
    const timings: Record<string, ReasoningTiming> = {}
    const message = { id: 'm1', parts: [reasoning('streaming')] }

    trackReasoningTimings(timings, message, { live: true, now: () => 1_000 })
    trackReasoningTimings(timings, message, { live: true, now: () => 1_500 })
    trackReasoningTimings(
      timings,
      { id: 'm1', parts: [reasoning('done')] },
      { live: true, now: () => 4_000 },
    )

    expect(timings[reasoningTimingKey('m1', 0)]).toEqual({ startedAt: 1_000, finishedAt: 4_000 })
  })

  it('leaves a restored transcript untimed instead of stamping it with "now"', () => {
    const timings: Record<string, ReasoningTiming> = {}

    trackReasoningTimings(
      timings,
      { id: 'restored', parts: [reasoning('done')] },
      { live: false, now: () => 9_000 },
    )

    expect(timings).toEqual({})
  })

  it('does not let one turn inherit the previous turn\u2019s start', () => {
    // The bug this guards: timings were keyed by position, so the reasoning
    // block of a fresh turn found the entry of the block that sat at the same
    // position before it — and reported the age of that one (a new "Hi!"
    // claiming 15 minutes of thinking).
    const timings: Record<string, ReasoningTiming> = {}
    trackReasoningTimings(
      timings,
      { id: 'earlier-turn', parts: [reasoning('streaming')] },
      { live: true, now: () => 1_000 },
    )

    trackReasoningTimings(
      timings,
      { id: 'later-turn', parts: [reasoning('streaming')] },
      { live: true, now: () => 908_000 },
    )

    expect(timings[reasoningTimingKey('later-turn', 0)]).toEqual({ startedAt: 908_000 })
  })

  it('still settles a block that finishes after the turn stopped being live', () => {
    const timings: Record<string, ReasoningTiming> = {}
    trackReasoningTimings(
      timings,
      { id: 'm1', parts: [reasoning('streaming')] },
      { live: true, now: () => 1_000 },
    )

    trackReasoningTimings(
      timings,
      { id: 'm1', parts: [reasoning('done')] },
      { live: false, now: () => 2_500 },
    )

    expect(timings[reasoningTimingKey('m1', 0)]?.finishedAt).toBe(2_500)
  })

  it('times each reasoning block of a multi-step turn separately', () => {
    const timings: Record<string, ReasoningTiming> = {}
    const step = (state: 'streaming' | 'done') => ({
      id: 'm1',
      parts: [reasoning('done'), { type: 'text' }, reasoning(state)],
    })

    trackReasoningTimings(timings, step('streaming'), { live: true, now: () => 1_000 })
    trackReasoningTimings(timings, step('done'), { live: true, now: () => 3_000 })

    expect(timings).toEqual({
      [reasoningTimingKey('m1', 2)]: { startedAt: 1_000, finishedAt: 3_000 },
    })
  })

  it('reports no duration for a block it never saw streaming', () => {
    // Joining a turn late (mode switched away and back) beats inventing a start.
    const timings: Record<string, ReasoningTiming> = {}

    trackReasoningTimings(
      timings,
      { id: 'm1', parts: [reasoning('done')] },
      { live: true, now: () => 5_000 },
    )

    expect(timings).toEqual({})
  })
})
