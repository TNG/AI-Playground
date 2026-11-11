import type { ChannelKind } from '@/assets/js/store/channels/types'
import { CHANNEL_ANSWERING } from '@/lib/answerButton'
import { channelMediaType } from '@/lib/channelMediaKind'
import { escapeMarkupText } from '@/lib/escapeMarkupText'
import { markdownToSlackMrkdwn } from '@/lib/slackMrkdwn'
import { markdownToTelegramHtml } from '@/lib/telegramMarkdown'
import type { IpcOkWith } from '@/types/ipcChannels'
import { plainTextOf, type ChannelText } from './channelText.ts'
import type { ChannelMessage, ChannelTypingState, NotificationChannel } from './notifier.ts'

/** The Channels backend's `channelSend`, narrowed to what a Notification uses. */
export type ChannelSend = (
  kind: ChannelKind,
  action:
    'reply' | 'post' | 'keyboard' | 'photo' | 'video' | 'voice' | 'document' | 'typing' | 'update',
  payload: Record<string, unknown>,
) => Promise<IpcOkWith<{ ts?: string; channel?: string; messageId?: number }>>

type TextAction = 'reply' | 'post' | 'keyboard' | 'update'
type MediaAction = 'photo' | 'video' | 'voice' | 'document'

type Formatted = { text: string; parse_mode?: 'HTML' }

type Markup = {
  convert: (markdown: string) => string
  wrapHeader: (escapedHeader: string) => string
  parseMode?: 'HTML'
}

function formatterOf({ convert, wrapHeader, parseMode }: Markup) {
  return ({ header, text, footer, plain }: ChannelText): Formatted => {
    const lines = [
      header && wrapHeader(escapeMarkupText(header)),
      plain ? escapeMarkupText(text) : convert(text),
      footer && escapeMarkupText(footer),
    ]
    return {
      text: lines.filter(Boolean).join('\n'),
      ...(parseMode ? { parse_mode: parseMode } : {}),
    }
  }
}

// Slack mrkdwn has no escape for its markers, so a title's own would end the bold early.
const SLACK_MARKER_LOOKALIKES: Record<string, string> = { '*': '∗', _: '＿', '~': '∼' }

const telegramHtml = formatterOf({
  convert: markdownToTelegramHtml,
  wrapHeader: (header) => `<b>${header}</b>`,
  parseMode: 'HTML',
})

const slackMrkdwn = formatterOf({
  convert: markdownToSlackMrkdwn,
  wrapHeader: (header) =>
    `*${header.replace(/[*_~]/g, (marker) => SLACK_MARKER_LOOKALIKES[marker])}*`,
})

type Formatter = { format: (text: ChannelText) => Formatted; maxChars: number }

const FORMATTERS: Partial<Record<ChannelKind, Formatter>> = {
  telegram: { format: telegramHtml, maxChars: 4096 },
  slack: { format: slackMrkdwn, maxChars: 40000 },
}

const CAPTION_FORMATTERS: Partial<Record<ChannelKind, Formatter>> = {
  telegram: { format: telegramHtml, maxChars: 1024 },
}

const PARSE_ERROR = /can't parse entities/i

type Outgoing = { payload: Record<string, unknown>; content: ChannelText } & (
  { action: TextAction; field?: 'text' } | { action: MediaAction; field: 'caption' }
)

/** Sends the text formatted for `kind`; markup the platform rejects or cannot fit goes as plain text. */
async function sendFormatted(
  send: ChannelSend,
  kind: ChannelKind,
  { action, payload, content, field = 'text' }: Outgoing,
) {
  const plain = plainTextOf(content)
  const format = field === 'text' ? FORMATTERS[kind] : plain && CAPTION_FORMATTERS[kind]
  const formatted = format && format.format(content)
  const fits = formatted && formatted.text.length <= format.maxChars
  const { text, ...mode } = (fits && formatted) || { text: plain }
  const result = await send(kind, action, { ...payload, [field]: text, ...mode })
  if (result.success || !mode.parse_mode || !PARSE_ERROR.test(result.error)) return result
  return send(kind, action, { ...payload, [field]: plain })
}

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
      content: message,
      field: 'caption',
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
    content: message,
    field: 'caption',
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
        const result = await sendFormatted(send, kind, {
          action: 'update',
          payload: target,
          content: message,
        })
        return result.success ? { success: true, ref: settled.ref } : result
      }
      const result = await sendFormatted(send, kind, payloadOf(kind, message))
      if (!result.success) return result
      return { success: true, ref: result.messageId?.toString() ?? result.ts }
    },
    draft: async (kind, draft, text, replyTo) => {
      const answering = CHANNEL_ANSWERING[kind]
      if (answering.streaming === 'edited-post') {
        if (draft.ref && draft.chat) {
          const target = { channel: draft.chat, ts: draft.ref }
          const result = await sendFormatted(send, kind, {
            action: 'update',
            payload: target,
            content: text,
          })
          return result.success ? { success: true } : result
        }
        const target = replyTo ? { [answering.replyKey]: replyTo } : {}
        const result = await sendFormatted(send, kind, {
          action: 'reply',
          payload: target,
          content: text,
        })
        if (!result.success) return result
        return {
          success: true,
          ...(result.ts ? { ref: result.ts } : {}),
          ...(result.channel ? { chat: result.channel } : {}),
        }
      }
      const result = await sendFormatted(send, kind, {
        action: 'update',
        payload: { draft_id: draft.id },
        content: text,
      })
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
