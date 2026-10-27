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

  it('posts to LAN chat rather than replying, so it never takes over a streaming Home Agent answer', async () => {
    const { send, calls } = recorder()
    expect(await send('local-web', { text: 'done' })).toEqual({ success: true, ref: '41' })
    expect(calls).toEqual([{ kind: 'local-web', action: 'post', payload: { text: 'done' } }])
  })

  it('names the session an Answer button answers for LAN chat, whose page shows it in the composer', async () => {
    const { send, calls } = recorder()
    const message = {
      text: 'done',
      buttons: [[{ text: '💬 Answer', callbackData: 'answer' }]],
      answerTitle: '"Asteroids clone"',
    }
    await send('local-web', message)
    await send('telegram', message)
    expect(calls.map((call) => call.payload.answer_title)).toEqual(['"Asteroids clone"', undefined])
  })

  it('sends a message with buttons as a keyboard, still under the message it answers', async () => {
    const { send, calls } = recorder()
    await send('local-web', {
      text: 'done',
      replyTo: '77',
      buttons: [[{ text: '💬 Answer', callbackData: 'answer' }]],
    })
    expect(calls).toEqual([
      {
        kind: 'local-web',
        action: 'keyboard',
        payload: {
          text: 'done',
          buttons: [[{ text: '💬 Answer', callback_data: 'answer' }]],
          reply_to: '77',
        },
      },
    ])
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

describe('typing handed to the Home Agent channel', () => {
  it('is the chat action the channel takes from its own heartbeat', async () => {
    const { send, calls } = recorder()
    expect(await send('telegram', { typing: 'start' })).toEqual({ success: true })
    await send('local-web', { typing: 'start' })
    expect(calls).toEqual([
      { kind: 'telegram', action: 'typing', payload: { action: 'typing' } },
      { kind: 'local-web', action: 'typing', payload: { action: 'typing' } },
    ])
  })

  it('stops explicitly on LAN chat, and lets Telegram’s lapse on its own', async () => {
    const { send, calls } = recorder()
    expect(await send('telegram', { typing: 'stop' })).toEqual({ success: true })
    await send('local-web', { typing: 'stop' })
    expect(calls).toEqual([{ kind: 'local-web', action: 'typing', payload: { action: 'stop' } }])
  })
})
