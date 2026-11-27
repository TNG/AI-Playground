import { describe, expect, it } from 'vitest'
import { trialRunItems } from '@/lib/trialRunTimeline'
import type { AgentRunTag } from '@/types/sessionTimeline'

// A Trial Run's Harness Session record is the only place its turns live, so the
// Agent Library renders it from that record, the way the Session timeline renders a run.

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

const runPrompt = 'Carry out these steps.\n\n1. Read the news\n2. Ask me which city'
const run = [message('r1', 'user', runPrompt), message('a1', 'assistant', 'Which city?')]

const followUp = (id: string, text: string) => ({
  ...message(id, 'user', text),
  metadata: { followUp: { agentId: 't1', agentName: 'Morning digest' } },
})

describe('a Trial Run in the Agent Library', () => {
  it('starts with the run bubble, its full prompt kept to expand, then the reply as an ordinary Turn', () => {
    const items = trialRunItems({ ...trial, saved: run })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      kind: 'agent',
      hint: { kind: 'agent', preset: 'Morning digest' },
      prompt: {
        text: '',
        agentRun: { trigger: 'manual', name: 'Morning digest', startedAt: 500, prompt: runPrompt },
      },
      answers: [{ id: 'a1' }],
      footer: { actions: ['copy', 'speak'], text: 'Which city?' },
    })
    expect(items[0]).not.toHaveProperty('prompt.step')
    expect(items[0]).not.toHaveProperty('prompt.agentRun.agentId')
  })

  it('shows the input it was started with under the run bubble', () => {
    const items = trialRunItems({
      ...trial,
      taskRun: { ...taskRun, input: 'Only sports' },
      saved: run,
    })

    expect(items[0]).toMatchObject({ prompt: { text: 'Only sports' } })
  })

  it('shows Follow-ups as plain prompts to the Agent, its answers as ordinary Turns', () => {
    const items = trialRunItems({
      ...trial,
      saved: [...run, followUp('f1', 'Berlin'), message('a2', 'assistant', 'Sunny in Berlin.')],
    })

    expect(items).toHaveLength(2)
    expect(items[1]).toMatchObject({
      kind: 'agent',
      hint: { preset: 'Morning digest' },
      prompt: { text: 'Berlin' },
      answers: [{ id: 'a2' }],
    })
    expect(items[1]).not.toHaveProperty('prompt.agentRun')
  })

  it('offers neither Regenerate nor Delete on any of its Turns', () => {
    const saved = [...run, followUp('f1', 'Berlin'), message('a2', 'assistant', 'Sunny.')].map(
      (entry, index) =>
        entry.role === 'assistant' ? { ...entry, metadata: { harnessTurnId: `t${index}` } } : entry,
    )
    const items = trialRunItems({ ...trial, presetName: 'Assistant', saved })

    expect(items).toHaveLength(2)
    for (const item of items) {
      expect(item.kind === 'agent' && item.footer.actions).toEqual(
        expect.not.arrayContaining(['regenerate', 'delete']),
      )
      expect(item).not.toHaveProperty('footer.harnessTurn')
    }
  })

  it('streams its turn with the usual live status, and no Step progress', () => {
    const items = trialRunItems({
      ...trial,
      saved: [],
      live: [run[0], { ...message('a1', 'assistant', 'Which'), parts: [] }],
      inFlight: true,
    })

    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      prompt: { agentRun: { name: 'Morning digest' } },
      streaming: true,
      footer: { actions: [] },
    })
    expect(items[0]).not.toHaveProperty('details.progress')
  })

  it('shows as working once in flight, before its turn streams anything', () => {
    const items = trialRunItems({ ...trial, saved: [run[0]], inFlight: true })

    expect(items[0]).toMatchObject({ streaming: true, details: { live: { kind: 'working' } } })
  })

  it('says beside its reply when the run failed, not under a later Follow-up', () => {
    const items = trialRunItems({
      ...trial,
      taskRun: { ...taskRun, end: { kind: 'failed', message: 'Model crashed' } },
      saved: [...run, followUp('f1', 'again?'), message('a2', 'assistant', 'Yes.')],
    })

    expect(items[0]).toMatchObject({
      result: expect.arrayContaining([
        { kind: 'failure', state: 'failed', reason: 'Model crashed' },
      ]),
    })
    expect(items[1]).not.toMatchObject({
      result: expect.arrayContaining([expect.objectContaining({ kind: 'failure' })]),
    })
  })

  it('renders a Trial Run saved with several Steps flat, every prompt and reply kept', () => {
    const items = trialRunItems({
      ...trial,
      saved: [
        message('s1', 'user', 'Carry this out in 2 steps.\n\nStep 1 of 2: Read the news'),
        message('a1', 'assistant', 'Read it.'),
        message('s2', 'user', 'Step 2 of 2: Summarize it'),
        message('a2', 'assistant', 'Three headlines.'),
      ],
    })

    expect(items).toMatchObject([
      { prompt: { agentRun: { name: 'Morning digest' } }, answers: [{ id: 'a1' }] },
      { prompt: { text: 'Step 2 of 2: Summarize it' }, answers: [{ id: 'a2' }] },
    ])
    expect(items[1]).not.toHaveProperty('prompt.agentRun')
  })

  it('is nothing before its turn was sent', () => {
    expect(trialRunItems({ ...trial, saved: [] })).toEqual([])
  })
})
