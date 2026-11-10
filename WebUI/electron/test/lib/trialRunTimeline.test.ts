import { describe, expect, it } from 'vitest'
import { trialRunItems } from '@/lib/trialRunTimeline'
import type { AgentRunTag } from '@/types/sessionTimeline'

// A Trial Run's Harness Session record is the only place its turns live, so the
// Agent Library renders it from that record, as a conversation: one Turn per Step.

const taskRun: AgentRunTag = { taskName: 'Morning digest', startedAt: 500, trigger: 'manual' }
const trial = {
  harnessSessionId: 'aipg-agent-trial',
  presetName: 'Agent',
  taskRun,
}

const message = (id: string, role: 'user' | 'assistant', text: string) => ({
  id,
  role,
  parts: [{ type: 'text', text }],
})

const twoSteps = [
  message('s1', 'user', 'Carry this out in 2 steps.\n\nStep 1 of 2: Read the news'),
  message('a1', 'assistant', 'Read it.'),
  message('s2', 'user', 'Step 2 of 2: Summarize it'),
  message('a2', 'assistant', 'Three headlines.'),
]

describe('a Trial Run in the Agent Library', () => {
  it('reads like a conversation: each Step is the prompt the model got, labelled with its number, then its answer', () => {
    const items = trialRunItems({ ...trial, saved: twoSteps })

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({
      kind: 'agent',
      prompt: { text: 'Carry this out in 2 steps.\n\nStep 1 of 2: Read the news', step: 1 },
      answers: [{ id: 'a1' }],
      footer: { actions: ['copy', 'speak'], text: 'Read it.' },
    })
    expect(items[1]).toMatchObject({
      kind: 'agent',
      prompt: { text: 'Step 2 of 2: Summarize it', step: 2 },
      answers: [{ id: 'a2' }],
      footer: { actions: ['copy', 'speak'], text: 'Three headlines.' },
    })
    expect(items[0]).not.toHaveProperty('runKey')
    expect(items[0]).not.toHaveProperty('prompt.agentRun')
  })

  it('streams the Step in flight as the last Turn', () => {
    const items = trialRunItems({
      ...trial,
      saved: twoSteps.slice(0, 2),
      live: [...twoSteps.slice(0, 3), { ...message('a2', 'assistant', 'Three'), parts: [] }],
      progress: { step: 2, count: 2 },
    })

    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ streaming: false })
    expect(items[1]).toMatchObject({
      prompt: { text: 'Step 2 of 2: Summarize it', step: 2 },
      streaming: true,
      footer: { actions: [] },
    })
  })

  it('says under its last Step when the run failed', () => {
    const items = trialRunItems({
      ...trial,
      taskRun: { ...taskRun, end: { kind: 'failed', message: 'Model crashed' } },
      saved: twoSteps.slice(0, 2),
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      result: expect.arrayContaining([
        { kind: 'failure', state: 'failed', reason: 'Model crashed' },
      ]),
    })
  })

  it('is nothing before its first Step was sent', () => {
    expect(trialRunItems({ ...trial, saved: [] })).toEqual([])
  })
})
