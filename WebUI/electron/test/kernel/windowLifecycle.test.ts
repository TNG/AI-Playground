import { describe, expect, it } from 'vitest'
import { resolveClosePolicy } from '../../kernel/windowLifecycle'

// The hidden-window close policy (architecture-target §5.1). Closing the app
// window hides it while headless work a quit would orphan; otherwise it is a
// real close. Every combination that matters:

describe('resolveClosePolicy', () => {
  it('closes when nothing is in flight', () => {
    expect(
      resolveClosePolicy({ homeAgentRunning: false, rendererBusy: false, agentTurnActive: false }),
    ).toBe('close')
  })

  it('hides while the Home Agent serves its channels', () => {
    expect(
      resolveClosePolicy({ homeAgentRunning: true, rendererBusy: false, agentTurnActive: false }),
    ).toBe('hide')
  })

  it('hides while the renderer reports tracked work', () => {
    expect(
      resolveClosePolicy({ homeAgentRunning: false, rendererBusy: true, agentTurnActive: false }),
    ).toBe('hide')
  })

  it('hides while an agent turn runs in main', () => {
    expect(
      resolveClosePolicy({ homeAgentRunning: false, rendererBusy: false, agentTurnActive: true }),
    ).toBe('hide')
  })

  it('hides when several are in flight at once', () => {
    expect(
      resolveClosePolicy({ homeAgentRunning: true, rendererBusy: true, agentTurnActive: true }),
    ).toBe('hide')
  })
})
