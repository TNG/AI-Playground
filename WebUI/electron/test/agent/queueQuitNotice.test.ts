import { describe, expect, it } from 'vitest'
import { tellDroppedQueues } from '../../agent/queueQuitNotice'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import en from '@/assets/i18n/en-US.json'

// On quit, each Channel with queued messages hears how many were dropped.

function recorder() {
  const sent: { kind: ChannelKind; text: string }[] = []
  return {
    sent,
    send: async (kind: ChannelKind, text: string) => {
      sent.push({ kind, text })
    },
  }
}

const queued = (channel: ChannelKind, count: number) => ({
  kind: 'channel-queue' as const,
  channel,
  state: { status: 'queued' as const, count },
})

describe('tellDroppedQueues', () => {
  it('tells each Channel with queued messages how many were dropped', async () => {
    const { sent, send } = recorder()
    await tellDroppedQueues({
      queued: [queued('telegram', 3), queued('slack', 1)],
      channels: ['telegram', 'slack'],
      template: en.CHANNEL_QUEUE_DROPPED_QUIT,
      send,
    })
    expect(sent).toEqual([
      {
        kind: 'telegram',
        text: '⚠️ AI Playground closed, so your queued messages were dropped (3). Send them again once it is back.',
      },
      {
        kind: 'slack',
        text: '⚠️ AI Playground closed, so your queued messages were dropped (1). Send them again once it is back.',
      },
    ])
  })

  it('tells no Channel that is no longer on', async () => {
    const { sent, send } = recorder()
    await tellDroppedQueues({
      queued: [queued('telegram', 3)],
      channels: [],
      template: en.CHANNEL_QUEUE_DROPPED_QUIT,
      send,
    })
    expect(sent).toEqual([])
  })

  it('does not hold up the quit for a Channel that never answers', async () => {
    const started = Date.now()
    await tellDroppedQueues({
      queued: [queued('telegram', 3)],
      channels: ['telegram'],
      template: en.CHANNEL_QUEUE_DROPPED_QUIT,
      send: () => new Promise(() => {}),
      timeoutMs: 20,
    })
    expect(Date.now() - started).toBeLessThan(1000)
  })
})
