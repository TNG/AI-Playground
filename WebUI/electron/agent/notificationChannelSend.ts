import type { ChannelKind } from '@/assets/js/store/channels/types'
import { CHANNEL_ANSWERING } from '@/lib/answerButton'
import { channelMediaType } from '@/lib/channelMediaKind'
import type { IpcOkWith } from '@/types/ipcChannels'
import type { ChannelMessage, ChannelTypingState, NotificationChannel } from './notifier.ts'

/** The Channels backend's `channelSend`, narrowed to what a Notification uses. */
export type HomeAgentChannelSend = (
  kind: ChannelKind,
  action:
    'reply' | 'post' | 'keyboard' | 'photo' | 'video' | 'voice' | 'document' | 'typing' | 'update',
  payload: Record<string, unknown>,
) => Promise<IpcOkWith<{ ts?: string; channel?: string; messageId?: number }>>

function payloadOf(kind: ChannelKind, message: ChannelMessage) {
  const answering = CHANNEL_ANSWERING[kind]
  const target = message.replyTo ? { [answering.replyKey]: message.replyTo } : {}
  const { media, buttons, answerTitle } = message
  // A LAN chat draft is taken over by the message that settles it.
  const draft =
    message.draft && !media && kind === 'local-web' ? { draft_id: message.draft.id } : {}
  const title = answering.buttonCarriesTitle && answerTitle ? { answer_title: answerTitle } : {}
  const keyboard = buttons
    ? {
        buttons: buttons.map((row) =>
          row.map((button) => ({ text: button.text, callback_data: button.callbackData })),
        ),
        ...title,
      }
    : {}
  if (buttons && !media) {
    return {
      action: 'keyboard' as const,
      payload: { text: message.text, ...keyboard, ...target, ...draft },
    }
  }
  if (!media) {
    const action = answering.sendsAsPost ? ('post' as const) : ('reply' as const)
    return { action, payload: { text: message.text, ...target, ...draft } }
  }
  if (media.kind === 'voice') {
    return {
      action: 'voice' as const,
      payload: {
        audio: media.base64,
        mime: channelMediaType(media.filename) ?? 'audio/wav',
        caption: message.text,
        filename: media.filename,
        ...keyboard,
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
      ...keyboard,
      ...target,
    },
  }
}

/** Sends Notifications through the Channel; the ref is Telegram's id or Slack's ts. */
export function homeAgentNotificationChannel(send: HomeAgentChannelSend): NotificationChannel {
  return {
    send: async (kind, message) => {
      const settled = message.draft
      if (kind === 'slack' && settled?.ref && settled.chat && !message.media) {
        const result = await send(kind, 'update', {
          channel: settled.chat,
          ts: settled.ref,
          text: message.text,
        })
        return result.success ? { success: true, ref: settled.ref } : result
      }
      const { action, payload } = payloadOf(kind, message)
      const result = await send(kind, action, payload)
      if (!result.success) return result
      return { success: true, ref: result.messageId?.toString() ?? result.ts }
    },
    // Slack has no drafts: the first edit posts the message and later ones edit it.
    draft: async (kind, draft, text, replyTo) => {
      if (kind === 'slack') {
        if (draft.ref && draft.chat) {
          const result = await send(kind, 'update', { channel: draft.chat, ts: draft.ref, text })
          return result.success ? { success: true } : result
        }
        const target = replyTo ? { [CHANNEL_ANSWERING.slack.replyKey]: replyTo } : {}
        const result = await send(kind, 'reply', { text, ...target })
        if (!result.success) return result
        return {
          success: true,
          ...(result.ts ? { ref: result.ts } : {}),
          ...(result.channel ? { chat: result.channel } : {}),
        }
      }
      const result = await send(kind, 'update', { draft_id: draft.id, text })
      return result.success ? { success: true } : result
    },
    // The payload the renderer adapters send: a platform chat action, or LAN chat's literal stop.
    typing: async (kind: ChannelKind, state: ChannelTypingState) => {
      if (state === 'stop' && CHANNEL_ANSWERING[kind].typing !== 'stops') return { success: true }
      const result = await send(kind, 'typing', { action: state === 'stop' ? 'stop' : 'typing' })
      return result.success ? { success: true } : result
    },
  }
}
