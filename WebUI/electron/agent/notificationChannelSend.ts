import type { ChannelKind } from '@/assets/js/store/channels/types'
import { CHANNEL_ANSWERING } from '@/lib/answerButton'
import type { IpcOkWith } from '@/types/ipcChannels'
import type { ChannelMessage, ChannelSend, ChannelTyping } from './notifier.ts'

/** The Home Agent backend's `channelSend`, narrowed to what a Notification uses. */
export type HomeAgentChannelSend = (
  kind: ChannelKind,
  action: 'reply' | 'post' | 'keyboard' | 'photo' | 'video' | 'typing',
  payload: Record<string, unknown>,
) => Promise<IpcOkWith<{ ts?: string; channel?: string; messageId?: number }>>

function payloadOf(kind: ChannelKind, message: ChannelMessage) {
  const answering = CHANNEL_ANSWERING[kind]
  const target = message.replyTo ? { [answering.replyKey]: message.replyTo } : {}
  const { media, buttons, answerTitle } = message
  if (buttons && !media) {
    const rows = buttons.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    )
    const title = answering.buttonCarriesTitle && answerTitle ? { answer_title: answerTitle } : {}
    return {
      action: 'keyboard' as const,
      payload: { text: message.text, buttons: rows, ...title, ...target },
    }
  }
  if (!media) {
    const action = answering.sendsAsPost ? ('post' as const) : ('reply' as const)
    return { action, payload: { text: message.text, ...target } }
  }
  return {
    action: media.kind,
    payload: {
      [media.kind]: media.base64,
      caption: message.text,
      filename: media.filename,
      ...target,
    },
  }
}

// The payload the renderer adapters send: a platform chat action, or LAN chat's literal stop.
async function sendTyping(
  send: HomeAgentChannelSend,
  kind: ChannelKind,
  { typing }: ChannelTyping,
): ReturnType<ChannelSend> {
  if (typing === 'stop' && !CHANNEL_ANSWERING[kind].typingStops) return { success: true }
  const result = await send(kind, 'typing', { action: typing === 'stop' ? 'stop' : 'typing' })
  return result.success ? { success: true } : result
}

/** Sends Notifications through the Home Agent channel; the ref is Telegram's id or Slack's ts. */
export function notificationChannelSend(send: HomeAgentChannelSend): ChannelSend {
  return async (kind, message) => {
    if ('typing' in message) return sendTyping(send, kind, message)
    const { action, payload } = payloadOf(kind, message)
    const result = await send(kind, action, payload)
    if (!result.success) return result
    return { success: true, ref: result.messageId?.toString() ?? result.ts }
  }
}
