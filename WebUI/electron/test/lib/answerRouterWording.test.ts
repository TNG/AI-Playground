import { describe, expect, it } from 'vitest'
import { answerHelpLine, answerableNotice } from '../../../src/lib/answerRouterWording'

describe('answering wording per channel', () => {
  it('tells /help on each channel the gesture that answers there', () => {
    expect(answerHelpLine('telegram')).toBe(
      "To answer a Session's message, reply to it. Plain messages go to your Channel Session.",
    )
    expect(answerHelpLine('slack')).toBe(
      "To answer a Session's message, reply in its thread. Plain messages go to your Channel Session.",
    )
    expect(answerHelpLine('local-web')).toBe(
      "To answer a Session's message, tap 💬 Answer under it. Plain messages go to your Channel Session.",
    )
  })

  it('has no answering line on a channel agents cannot be answered on', () => {
    expect(answerHelpLine('discord')).toBeNull()
  })

  it('describes the gesture of the channel being set up', () => {
    expect(answerableNotice('telegram')).toBe(
      'Sessions marked "Reachable from Channels" can message you here. To answer one, reply to its message. Plain messages go to your Channel Session.',
    )
    expect(answerableNotice('slack')).toBe(
      'Sessions marked "Reachable from Channels" can message you here. To answer one, reply in its thread. Plain messages go to your Channel Session.',
    )
    expect(answerableNotice('local-web')).toBe(
      'Sessions marked "Reachable from Channels" can message you here. To answer one, tap 💬 Answer. Plain messages go to your Channel Session.',
    )
    expect(answerableNotice('discord')).toBeNull()
  })
})
