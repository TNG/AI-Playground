import { describe, expect, it } from 'vitest'
import { answerHelpLine, answerableNotice } from '../../../src/lib/answerRouterWording'
import enUS from '../../../src/assets/i18n/en-US.json'

describe('answering wording per channel', () => {
  it('tells /help on each channel the gesture that answers there', () => {
    expect(answerHelpLine('telegram')).toBe(
      'To answer an agent, reply to its message. Plain messages go to Home Agent.',
    )
    expect(answerHelpLine('slack')).toBe(
      'To answer an agent, reply in its thread. Plain messages go to Home Agent.',
    )
    expect(answerHelpLine('local-web')).toBe(
      'To answer an agent, tap 💬 Answer. Plain messages go to Home Agent.',
    )
  })

  it('has no answering line on a channel agents cannot be answered on', () => {
    expect(answerHelpLine('discord')).toBeNull()
  })

  it('describes the gesture of the channel being set up', () => {
    expect(answerableNotice('telegram', enUS)).toBe(
      'Agents can message you on this channel. To answer one, reply to its message. Plain messages go to Home Agent.',
    )
    expect(answerableNotice('slack', enUS)).toBe(
      'Agents can message you on this channel. To answer one, reply in its thread. Plain messages go to Home Agent.',
    )
    expect(answerableNotice('local-web', enUS)).toBe(
      'Agents can message you on this channel. To answer one, tap 💬 Answer. Plain messages go to Home Agent.',
    )
    expect(answerableNotice('discord', enUS)).toBeNull()
  })
})
