import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { IpcOkWith } from '@/types/ipcChannels'
import type { ChannelMessage, ChannelSend } from './notifier.ts'

/** The Home Agent backend's `channelSend`, narrowed to what a Notification uses. */
export type HomeAgentChannelSend = (
  kind: ChannelKind,
  action: 'reply' | 'post' | 'keyboard' | 'photo' | 'video',
  payload: Record<string, unknown>,
) => Promise<IpcOkWith<{ ts?: string; channel?: string; messageId?: number }>>

/** How each platform's channel names the message a send replies to. */
function replyTarget(kind: ChannelKind, ref: string): Record<string, string> {
  switch (kind) {
    case 'telegram':
      return { reply_to_message_id: ref }
    case 'slack':
      return { thread_ts: ref }
    default:
      return { reply_to: ref }
  }
}

function payloadOf(kind: ChannelKind, message: ChannelMessage) {
  const target = message.replyTo ? replyTarget(kind, message.replyTo) : {}
  const { media, buttons, answerTitle } = message
  if (buttons && !media) {
    const rows = buttons.map((row) =>
      row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
    )
    const title = kind === 'local-web' && answerTitle ? { answer_title: answerTitle } : {}
    return {
      action: 'keyboard' as const,
      payload: { text: message.text, buttons: rows, ...title, ...target },
    }
  }
  if (!media) {
    // A LAN chat `reply` settles the streaming Home Agent bubble; `post` stands on its own.
    const action = kind === 'local-web' ? ('post' as const) : ('reply' as const)
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

/** Sends Notifications through the Home Agent channel; the ref is Telegram's id or Slack's ts. */
export function notificationChannelSend(send: HomeAgentChannelSend): ChannelSend {
  return async (kind, message) => {
    const { action, payload } = payloadOf(kind, message)
    const result = await send(kind, action, payload)
    if (!result.success) return result
    return { success: true, ref: result.messageId?.toString() ?? result.ts }
  }
}
