import { describe, expect, it } from 'vitest'
import { closeQuestionLines } from '@/lib/closeQuestionLines'
import en from '@/assets/i18n/en-US.json'

// The close dialog's lines, read with the English strings.

describe('closeQuestionLines', () => {
  it('names a Trial Run by its Agent, with its Step', () => {
    const lines = closeQuestionLines(
      {
        items: [
          {
            kind: 'trial-run',
            agentId: 'agent-1',
            sessionId: 'trial-harness',
            name: 'Morning news',
            state: { status: 'step', index: 2, count: 3 },
          },
        ],
        more: 0,
      },
      en,
    )

    expect(lines).toEqual(["Trial Run of 'Morning news': step 2 of 3"])
  })

  it('names a Trial Run still in its pre-flight checks', () => {
    const lines = closeQuestionLines(
      {
        items: [{ kind: 'trial-run', agentId: 'agent-1', state: { status: 'starting' } }],
        more: 0,
      },
      en,
    )

    expect(lines).toEqual(['Trial Run: starting'])
  })

  it('names the Channel whose messages are queued, and how many', () => {
    const lines = closeQuestionLines(
      {
        items: [
          { kind: 'channel-queue', channel: 'local-web', state: { status: 'queued', count: 2 } },
        ],
        more: 0,
      },
      en,
    )

    expect(lines).toEqual(['Messages queued from LAN chat: 2 queued'])
  })
})
