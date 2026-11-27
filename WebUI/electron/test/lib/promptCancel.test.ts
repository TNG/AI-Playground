import { describe, expect, it } from 'vitest'
import { planCancel, type CancelableTurn } from '@/lib/promptCancel'

const turn = (
  kind: CancelableTurn['kind'],
  extra: Partial<CancelableTurn> = {},
): CancelableTurn => ({ turnId: 't1', kind, ...extra })

const plan = (over: Partial<Parameters<typeof planCancel>[0]>) =>
  planCancel({
    queuedBehindRun: false,
    agentRunInSession: false,
    turn: null,
    mode: 'chat',
    openAgentSessionId: null,
    ...over,
  })

describe('what the prompt bar Stop acts on', () => {
  it('holds a queued prompt or stops the open Agent Run before touching a Turn', () => {
    expect(plan({ queuedBehindRun: true, agentRunInSession: true, turn: turn('chat') })).toEqual({
      kind: 'queued-prompt',
    })
    expect(plan({ agentRunInSession: true, turn: turn('chat') })).toEqual({ kind: 'agent-run' })
  })

  it("stops this mode's own Turn with the mode's cancel callback", () => {
    expect(plan({ mode: 'chat', turn: turn('chat') })).toEqual({
      kind: 'mode',
      turn: turn('chat'),
    })
    expect(plan({ mode: 'audio', turn: turn('audio') })).toEqual({
      kind: 'mode',
      turn: turn('audio'),
    })
    for (const mode of ['imageGen', 'imageEdit', 'video'] as const) {
      expect(plan({ mode, turn: turn('media') })).toEqual({ kind: 'mode', turn: turn('media') })
    }
    const agent = turn('agent', { harnessSessionId: 'h1' })
    expect(plan({ mode: 'agent', turn: agent, openAgentSessionId: 'h1' })).toEqual({
      kind: 'mode',
      turn: agent,
    })
  })

  it("stops another mode's Turn through the open Session's ledger", () => {
    expect(plan({ mode: 'imageGen', turn: turn('chat') })).toEqual({
      kind: 'ledger',
      turn: turn('chat'),
    })
    expect(plan({ mode: 'chat', turn: turn('audio') })).toEqual({
      kind: 'ledger',
      turn: turn('audio'),
    })
    const agent = turn('agent', { harnessSessionId: 'h1' })
    expect(plan({ mode: 'agent', turn: agent, openAgentSessionId: 'h2' })).toEqual({
      kind: 'ledger',
      turn: agent,
    })
  })

  it('has no Turn to mark when only the mode is busy', () => {
    expect(plan({ mode: 'chat', turn: null })).toEqual({ kind: 'mode', turn: null })
  })
})
