import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { createChannelTyping } from '../../agent/channelTyping'

// "typing…" as a Channel sees it while several turns run on it.

let pulses: Array<[ChannelKind, 'start' | 'stop']> = []
const typing = () => createChannelTyping((kind, state) => pulses.push([kind, state]), 4000)

beforeEach(() => {
  vi.useFakeTimers()
  pulses = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('typing on a Channel', () => {
  it('stays on while any of its turns runs and stops when the last one stops', () => {
    const channelTyping = typing()
    channelTyping.start('turn-a', 'local-web')
    channelTyping.start('turn-b', 'local-web')
    channelTyping.stop('turn-a')
    vi.advanceTimersByTime(4000)
    expect(pulses).toEqual([
      ['local-web', 'start'],
      ['local-web', 'start'],
    ])
    channelTyping.stop('turn-b')
    vi.advanceTimersByTime(8000)
    expect(pulses.slice(2)).toEqual([['local-web', 'stop']])
  })

  it('counts each Channel apart', () => {
    const channelTyping = typing()
    channelTyping.start('turn-a', 'telegram')
    channelTyping.start('turn-b', 'local-web')
    channelTyping.stop('turn-a')
    expect(pulses).toEqual([
      ['telegram', 'start'],
      ['local-web', 'start'],
      ['telegram', 'stop'],
    ])
    channelTyping.stopAll()
    expect(pulses.at(-1)).toEqual(['local-web', 'stop'])
  })

  it('counts a turn once however often it is started or stopped', () => {
    const channelTyping = typing()
    channelTyping.start('turn-a', 'local-web')
    channelTyping.start('turn-a', 'local-web')
    channelTyping.start('turn-b', 'local-web')
    channelTyping.stop('turn-b')
    channelTyping.stop('turn-b')
    expect(pulses).toEqual([['local-web', 'start']])
    channelTyping.stop('turn-a')
    expect(pulses.at(-1)).toEqual(['local-web', 'stop'])
  })
})
