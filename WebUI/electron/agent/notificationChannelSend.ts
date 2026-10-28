import type { ChannelKind } from '@/assets/js/store/channels/types'
import { CHANNEL_ANSWERING } from '@/lib/answerButton'
import type { IpcOkWith } from '@/types/ipcChannels'
import type { ChannelMessage, ChannelTypingState, NotificationChannel } from './notifier.ts'

/** The Home Agent backend's `channelSend`, narrowed to what a Notification uses. */
export type HomeAgentChannelSend = (
  kind: ChannelKind,
  action: 'reply' | 'post' | 'keyboard' | 'photo' | 'video' | 'voice' | 'typing',
  payload: Record<string, unknown>,
) => Promise<IpcOkWith<{ ts?: string; channel?: string; messageId?: number }>>

const VOICE_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
}

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
  if (media.kind === 'voice') {
    const extension = media.filename.split('.').pop()?.toLowerCase() ?? ''
    return {
      action: 'voice' as const,
      payload: {
        audio: media.base64,
        mime: VOICE_MIME[extension] ?? 'audio/wav',
        caption: message.text,
        filename: media.filename,
        ...target,
      },
    }
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
export function homeAgentNotificationChannel(send: HomeAgentChannelSend): NotificationChannel {
  return {
    send: async (kind, message) => {
      const { action, payload } = payloadOf(kind, message)
      const result = await send(kind, action, payload)
      if (!result.success) return result
      return { success: true, ref: result.messageId?.toString() ?? result.ts }
    },
    // The payload the renderer adapters send: a platform chat action, or LAN chat's literal stop.
    typing: async (kind: ChannelKind, state: ChannelTypingState) => {
      if (state === 'stop' && CHANNEL_ANSWERING[kind].typing !== 'stops') return { success: true }
      const result = await send(kind, 'typing', { action: state === 'stop' ? 'stop' : 'typing' })
      return result.success ? { success: true } : result
    },
  }
}
