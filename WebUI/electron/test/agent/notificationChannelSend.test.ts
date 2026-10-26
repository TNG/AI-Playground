import { describe, expect, it } from 'vitest'
import { notificationChannelSend } from '../../agent/notificationChannelSend'
import type { ChannelKind } from '@/assets/js/store/channels/types'

// What the Home Agent channel is asked to send for a Notification, per platform.

function recorder(result: { messageId?: number; ts?: string } = { messageId: 41 }) {
  const calls: Array<{ kind: ChannelKind; action: string; payload: Record<string, unknown> }> = []
  const send = notificationChannelSend(async (kind, action, payload) => {
    calls.push({ kind, action, payload })
    return { success: true, ...result }
  })
  return { send, calls }
}

describe('a Notification handed to the Home Agent channel', () => {
  it('is a plain reply, and its ref is the Telegram message id', async () => {
    const { send, calls } = recorder()
    expect(await send('telegram', { text: 'hi' })).toEqual({ success: true, ref: '41' })
    expect(calls).toEqual([{ kind: 'telegram', action: 'reply', payload: { text: 'hi' } }])
  })

  it('takes the Slack message ts as its ref', async () => {
    const { send } = recorder({ ts: '1700000000.0002' })
    expect(await send('slack', { text: 'hi' })).toEqual({ success: true, ref: '1700000000.0002' })
  })

  it.each([
    ['telegram', { reply_to_message_id: '77' }],
    ['slack', { thread_ts: '77' }],
    ['local-web', { reply_to: '77' }],
  ] as const)('names the message it answers the way %s expects', async (kind, target) => {
    const { send, calls } = recorder()
    await send(kind, { text: 'done', replyTo: '77' })
    expect(calls[0].payload).toEqual({ text: 'done', ...target })
  })

  it('sends media as a photo or video captioned with the text', async () => {
    const { send, calls } = recorder()
    await send('telegram', {
      text: 'header',
      replyTo: '77',
      media: { kind: 'photo', base64: 'AAA', filename: 'cover.png' },
    })
    await send('telegram', {
      text: 'header',
      media: { kind: 'video', base64: 'BBB', filename: 'intro.mp4' },
    })
    expect(calls).toEqual([
      {
        kind: 'telegram',
        action: 'photo',
        payload: {
          photo: 'AAA',
          caption: 'header',
          filename: 'cover.png',
          reply_to_message_id: '77',
        },
      },
      {
        kind: 'telegram',
        action: 'video',
        payload: { video: 'BBB', caption: 'header', filename: 'intro.mp4' },
      },
    ])
  })

  it('passes a failed send on', async () => {
    const send = notificationChannelSend(async () => ({ success: false, error: 'offline' }))
    expect(await send('telegram', { text: 'hi' })).toEqual({ success: false, error: 'offline' })
  })
})
