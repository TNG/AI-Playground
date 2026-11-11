import type { ChannelKind } from '@/assets/js/store/channels/types'
import { CHANNEL_ANSWERING } from '@/lib/answerButton'
import { channelMediaType } from '@/lib/channelMediaKind'
import { escapeSlackText, markdownToSlackMrkdwn } from '@/lib/slackMrkdwn'
import { escapeTelegramText, markdownToTelegramHtml } from '@/lib/telegramMarkdown'
import type { IpcOkWith } from '@/types/ipcChannels'
import type { ChannelMessage, ChannelTypingState, NotificationChannel } from './notifier.ts'

/** The Channels backend's `channelSend`, narrowed to what a Notification uses. */
export type ChannelSend = (
  kind: ChannelKind,
  action:
    'reply' | 'post' | 'keyboard' | 'photo' | 'video' | 'voice' | 'document' | 'typing' | 'update',
  payload: Record<string, unknown>,
) => Promise<IpcOkWith<{ ts?: string; channel?: string; messageId?: number }>>

type TextAction = 'reply' | 'post' | 'keyboard' | 'update'

/** A message's text: a plain header and footer around a body that is markdown unless `plain`. */
export type ChannelText = Pick<ChannelMessage, 'header' | 'text' | 'footer' | 'plain'>

/** The text as one plain string, the way LAN chat shows it. */
export function plainTextOf({ header, text, footer }: ChannelText): string {
  return [header, text, footer].filter(Boolean).join('\n')
}

type Formatted = { text: string; parse_mode?: 'HTML' }

function telegramHtml({ header, text, footer, plain }: ChannelText): Formatted {
  const lines = [
    header && `<b>${escapeTelegramText(header)}</b>`,
    plain ? escapeTelegramText(text) : markdownToTelegramHtml(text),
    footer && escapeTelegramText(footer),
  ]
  return { text: lines.filter(Boolean).join('\n'), parse_mode: 'HTML' }
}

function slackMrkdwn({ header, text, footer, plain }: ChannelText): Formatted {
  const lines = [
    header && `*${escapeSlackText(header)}*`,
    plain ? escapeSlackText(text) : markdownToSlackMrkdwn(text),
    footer && escapeSlackText(footer),
  ]
  return { text: lines.filter(Boolean).join('\n') }
}

/** Channels that render the body's markdown; the others show the plain text. */
const FORMATTERS: Partial<Record<ChannelKind, (text: ChannelText) => Formatted>> = {
  telegram: telegramHtml,
  slack: slackMrkdwn,
}

/** Channels that render a media caption's markdown; the others caption with the plain text. */
const CAPTION_FORMATTERS: Partial<Record<ChannelKind, (text: ChannelText) => Formatted>> = {
  telegram: telegramHtml,
}

const PARSE_ERROR = /can't parse entities/i

type MediaAction = 'photo' | 'video' | 'voice' | 'document'

/** Sends the text formatted for `kind`; markup the platform cannot parse goes again as plain text. */
async function sendText(
  send: ChannelSend,
  kind: ChannelKind,
  action: TextAction | MediaAction,
  payload: Record<string, unknown>,
  content: ChannelText,
  field: 'text' | 'caption' = 'text',
) {
  const plain = plainTextOf(content)
  const format = field === 'text' ? FORMATTERS[kind] : plain && CAPTION_FORMATTERS[kind]
  const { text, ...mode } = (format && format(content)) || { text: plain }
  const result = await send(kind, action, { ...payload, [field]: text, ...mode })
  if (result.success || !mode.parse_mode || !PARSE_ERROR.test(result.error)) return result
  return send(kind, action, { ...payload, [field]: plain })
}

type Outgoing =
  | { action: TextAction; payload: Record<string, unknown>; content: ChannelText }
  | { action: MediaAction; payload: Record<string, unknown>; caption: ChannelText }

function payloadOf(kind: ChannelKind, message: ChannelMessage): Outgoing {
  const answering = CHANNEL_ANSWERING[kind]
  const target = message.replyTo ? { [answering.replyKey]: message.replyTo } : {}
  const { media, buttons, answerTitle } = message
  const draft =
    message.draft && !media && answering.streaming === 'taken-over'
      ? { draft_id: message.draft.id }
      : {}
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
    return { action: 'keyboard', payload: { ...keyboard, ...target, ...draft }, content: message }
  }
  if (!media) {
    const action = answering.sendsAsPost ? 'post' : 'reply'
    return { action, payload: { ...target, ...draft }, content: message }
  }
  if (media.kind === 'voice') {
    return {
      action: 'voice',
      payload: {
        audio: media.base64,
        mime: channelMediaType(media.filename) ?? 'audio/wav',
        filename: media.filename,
        ...keyboard,
        ...target,
      },
      caption: message,
    }
  }
  return {
    action: media.kind,
    payload: {
      [media.kind]: media.base64,
      filename: media.filename,
      ...keyboard,
      ...target,
    },
    caption: message,
  }
}

/** Sends Notifications through the Channel; the ref is Telegram's id or Slack's ts. */
export function createNotificationChannel(send: ChannelSend): NotificationChannel {
  return {
    send: async (kind, message) => {
      const settled = message.draft
      const editsPost = CHANNEL_ANSWERING[kind].streaming === 'edited-post'
      if (editsPost && settled?.ref && settled.chat && !message.media) {
        const target = { channel: settled.chat, ts: settled.ref }
        const result = await sendText(send, kind, 'update', target, message)
        return result.success ? { success: true, ref: settled.ref } : result
      }
      const outgoing = payloadOf(kind, message)
      const result =
        'content' in outgoing
          ? await sendText(send, kind, outgoing.action, outgoing.payload, outgoing.content)
          : await sendText(
              send,
              kind,
              outgoing.action,
              outgoing.payload,
              outgoing.caption,
              'caption',
            )
      if (!result.success) return result
      return { success: true, ref: result.messageId?.toString() ?? result.ts }
    },
    draft: async (kind, draft, text, replyTo) => {
      const answering = CHANNEL_ANSWERING[kind]
      if (answering.streaming === 'edited-post') {
        if (draft.ref && draft.chat) {
          const target = { channel: draft.chat, ts: draft.ref }
          const result = await sendText(send, kind, 'update', target, text)
          return result.success ? { success: true } : result
        }
        const target = replyTo ? { [answering.replyKey]: replyTo } : {}
        const result = await sendText(send, kind, 'reply', target, text)
        if (!result.success) return result
        return {
          success: true,
          ...(result.ts ? { ref: result.ts } : {}),
          ...(result.channel ? { chat: result.channel } : {}),
        }
      }
      const result = await sendText(send, kind, 'update', { draft_id: draft.id }, text)
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
