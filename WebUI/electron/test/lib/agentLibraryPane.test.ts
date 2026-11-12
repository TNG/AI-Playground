import { describe, expect, it } from 'vitest'
import { trialRunOnScreen } from '@/lib/agentLibraryPane'

const trialRuns: Record<string, string> = { t1: 'session-t1', t2: 'session-t2' }
const trialRunSessionOf = (agentId: string) => trialRuns[agentId]

describe('trialRunOnScreen', () => {
  it("is the selected Agent's Trial Run on a wide layout, whatever tab is shown", () => {
    for (const shownTab of ['steps', 'inferencing', 'attributes', 'schedules'] as const) {
      expect(
        trialRunOnScreen({ selectedAgentId: 't1', trialRunSessionOf, wide: true, shownTab }),
      ).toBe('session-t1')
    }
  })

  it("is the selected Agent's Trial Run on a narrow layout showing the Trial Run tab", () => {
    expect(
      trialRunOnScreen({
        selectedAgentId: 't2',
        trialRunSessionOf,
        wide: false,
        shownTab: 'trial',
      }),
    ).toBe('session-t2')
  })

  it('is nothing on a narrow layout showing another tab', () => {
    expect(
      trialRunOnScreen({
        selectedAgentId: 't1',
        trialRunSessionOf,
        wide: false,
        shownTab: 'steps',
      }),
    ).toBeNull()
  })

  it("never puts a different Agent's Trial Run on screen", () => {
    expect(
      trialRunOnScreen({ selectedAgentId: 't3', trialRunSessionOf, wide: true, shownTab: 'steps' }),
    ).toBeNull()
  })

  it('is nothing when no Agent is selected', () => {
    expect(
      trialRunOnScreen({
        selectedAgentId: undefined,
        trialRunSessionOf,
        wide: true,
        shownTab: 'trial',
      }),
    ).toBeNull()
  })

  it('is nothing when the selected Agent has no Trial Run', () => {
    expect(
      trialRunOnScreen({
        selectedAgentId: 't1',
        trialRunSessionOf: () => undefined,
        wide: false,
        shownTab: 'trial',
      }),
    ).toBeNull()
  })
})
