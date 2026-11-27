import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { harnessTurnEndOf, stampHarnessTurnEnd } from '@/lib/harnessTurnEnd'

const message = (id: string, metadata: Record<string, unknown>): UIMessage =>
  ({ id, role: 'assistant', parts: [], metadata }) as UIMessage

describe('stamping how a harness turn ended', () => {
  it('marks only the newest harness turn', () => {
    const messages = [
      message('a1', { harnessTurnId: 't1' }),
      message('a2', { harnessTurnId: 't2' }),
      message('a3', { harnessTurnId: 't2' }),
    ]

    const stamped = stampHarnessTurnEnd(messages, 'cancelled')

    expect(harnessTurnEndOf(stamped[0])).toBeUndefined()
    expect(harnessTurnEndOf(stamped[1])).toBe('cancelled')
    expect(harnessTurnEndOf(stamped[2])).toBe('cancelled')
  })

  it('leaves the input untouched', () => {
    const messages = [message('a1', { harnessTurnId: 't1' })]

    const stamped = stampHarnessTurnEnd(messages, 'cancelled')

    expect(stamped).not.toBe(messages)
    expect(harnessTurnEndOf(messages[0])).toBeUndefined()
  })

  it('does nothing for a transcript with no harness turn', () => {
    const messages = [message('a1', {})]

    expect(stampHarnessTurnEnd(messages, 'cancelled')).toEqual(messages)
  })
})
