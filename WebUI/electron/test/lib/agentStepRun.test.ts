import { describe, expect, it } from 'vitest'
import { sendRunStep, type RunStep, type StepSender } from '@/lib/agentStepRun'

function recordingSender() {
  const sent: Array<{ taskName: string; stepIndex: number; notifiesResult?: boolean }> = []
  const sender: StepSender = {
    sendToSession: async (_sessionId, _prompt, options) => {
      sent.push(options.taskRun)
      return { ok: true }
    },
    releaseHeldAnswer: () => {},
  }
  return { sender, sent }
}

const step = (stepIndex: number, scheduled?: boolean): RunStep => ({
  sessionId: 'aipg-agent-run',
  stepIndex,
  taskName: 'Daily digest',
  steps: ['fetch', 'summarize'].map((prompt) => ({ id: prompt, prompt })),
  settingsTemplate: {},
  signal: new AbortController().signal,
  ...(scheduled !== undefined ? { scheduled } : {}),
})

describe('sendRunStep', () => {
  it('asks for the result Notification on a Scheduled Run’s last Step only', async () => {
    const { sender, sent } = recordingSender()
    await sendRunStep(sender, step(1, true), () => {})
    await sendRunStep(sender, step(2, true), () => {})
    await sendRunStep(sender, step(2), () => {})
    expect(sent).toEqual([
      { taskName: 'Daily digest', stepIndex: 1 },
      { taskName: 'Daily digest', stepIndex: 2, notifiesResult: true },
      { taskName: 'Daily digest', stepIndex: 2 },
    ])
  })
})
