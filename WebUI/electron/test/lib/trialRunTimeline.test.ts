import { describe, expect, it } from 'vitest'
import { trialRunItems } from '@/lib/trialRunTimeline'
import type { AgentRunTag } from '@/types/sessionTimeline'

// A Trial Run's Harness Session record is the only place its turns live, so the
// Agent Library renders it from that record, as one Turn like an Agent Run.

const taskRun: AgentRunTag = { taskName: 'Morning digest', startedAt: 500, trigger: 'manual' }
const trial = { harnessSessionId: 'aipg-agent-trial', presetName: 'Agent', taskRun }

const message = (id: string, role: 'user' | 'assistant', text: string) => ({
  id,
  role,
  parts: [{ type: 'text', text }],
})

const twoSteps = [
  message('s1', 'user', 'Step 1 of 2: Read the news'),
  message('a1', 'assistant', 'Read it.'),
  message('s2', 'user', 'Step 2 of 2: Summarize it'),
  message('a2', 'assistant', 'Three headlines.'),
]

describe('a Trial Run in the Agent Library', () => {
  it('is one Turn that ran the Agent, answering with its last Step', () => {
    const items = trialRunItems({ ...trial, saved: twoSteps })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'agent',
      prompt: { agentRun: { trigger: 'manual', name: 'Morning digest' } },
      answers: [{ id: 'a1' }, { id: 'a2' }],
      footer: { actions: ['copy'], text: 'Three headlines.' },
    })
  })

  it('streams the Step in flight and says which Step of how many it is on', () => {
    const items = trialRunItems({
      ...trial,
      saved: twoSteps.slice(0, 2),
      live: [...twoSteps.slice(0, 3), { ...message('a2', 'assistant', 'Three'), parts: [] }],
      progress: { step: 2, count: 2 },
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      streaming: true,
      details: { progress: { step: 2, count: 2 } },
      footer: { actions: [] },
    })
  })

  it('is nothing before its first Step was sent', () => {
    expect(trialRunItems({ ...trial, saved: [] })).toEqual([])
  })
})
