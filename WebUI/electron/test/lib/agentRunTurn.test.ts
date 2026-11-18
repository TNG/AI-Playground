import { describe, expect, it } from 'vitest'
import { sendRunTurn, type RunTurn, type RunTurnSender } from '@/lib/agentRunTurn'

function recordingSender() {
  const sent: Array<{ taskName: string; notifiesResult?: boolean }> = []
  const sender: RunTurnSender = {
    sendToSession: async (_sessionId, _prompt, options) => {
      sent.push(options.taskRun)
      return { ok: true }
    },
  }
  return { sender, sent }
}

const run = (overrides: Partial<RunTurn> = {}): RunTurn => ({
  sessionId: 'aipg-agent-run',
  taskName: 'Daily digest',
  steps: ['fetch', 'summarize'].map((prompt) => ({ id: prompt, prompt })),
  settingsTemplate: {},
  signal: new AbortController().signal,
  ...overrides,
})

describe('sendRunTurn', () => {
  it('asks for the result Notification on a Scheduled or Channel-started run only', async () => {
    const { sender, sent } = recordingSender()
    await sendRunTurn(sender, run({ scheduled: true }), () => {})
    await sendRunTurn(sender, run({ origin: { channel: 'telegram', replyTo: '1' } }), () => {})
    await sendRunTurn(sender, run(), () => {})
    expect(sent).toEqual([
      { taskName: 'Daily digest', notifiesResult: true },
      { taskName: 'Daily digest', notifiesResult: true },
      { taskName: 'Daily digest' },
    ])
  })
})
