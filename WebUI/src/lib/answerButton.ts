import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'
import type { AnswerRouterCopy } from '@/lib/answerRouterWording'
import type { NotificationTemplates } from '@/types/notificationsIpc'

/** The callback of the 💬 Answer button; the tapped message itself names the session. */
export const ANSWER_CALLBACK = 'answer'

export type AnswerGesture = 'button' | 'thread' | 'reply'

type GestureWording = {
  /** The `/help` line. */
  help: keyof AnswerRouterCopy
  /** The setup screen's note. */
  notice: keyof AnswerRouterCopy
  /** The last line of an answerable agent message; null where a button answers it instead. */
  hint: keyof Pick<NotificationTemplates, 'answerByReply' | 'answerInThread'> | null
}

/** How each gesture is worded wherever answering is explained. */
export const GESTURE_WORDING: Record<AnswerGesture, GestureWording> = {
  reply: { help: 'helpReply', notice: 'noticeReply', hint: 'answerByReply' },
  thread: { help: 'helpThread', notice: 'noticeThread', hint: 'answerInThread' },
  button: { help: 'helpButton', notice: 'noticeButton', hint: null },
}

/** How a channel answers an agent's message, and how a send there names the message it replies to. */
type ChannelAnswering = {
  /** `button`: the 💬 Answer button (LAN chat's composer chip); `thread`: replying in its thread; `reply`: replying to the message. */
  gesture: AnswerGesture | null
  replyKey: string
  /** The LAN page's chip names the session, so its button carries the title. */
  buttonCarriesTitle: boolean
  /** A LAN chat `reply` settles the streaming Home Agent bubble; `post` stands on its own. */
  sendsAsPost: boolean
  /** "typing…" while the turn an Answer started runs, and how it ends; null: main cannot show it. */
  typing: null | 'lapses' | 'stops'
}

export const CHANNEL_ANSWERING: Record<ChannelKind, ChannelAnswering> = {
  telegram: {
    gesture: 'reply',
    replyKey: 'reply_to_message_id',
    buttonCarriesTitle: false,
    sendsAsPost: false,
    typing: 'lapses',
  },
  slack: {
    gesture: 'thread',
    replyKey: 'thread_ts',
    buttonCarriesTitle: false,
    sendsAsPost: false,
    typing: null,
  },
  'local-web': {
    gesture: 'button',
    replyKey: 'reply_to',
    buttonCarriesTitle: true,
    sendsAsPost: true,
    typing: 'stops',
  },
  discord: {
    gesture: null,
    replyKey: 'reply_to',
    buttonCarriesTitle: false,
    sendsAsPost: false,
    typing: null,
  },
}

export function answerGesture(kind: ChannelKind): AnswerGesture | null {
  return CHANNEL_ANSWERING[kind].gesture
}

/** Whether the turn an Answer started shows "typing…", which then acknowledges the Answer. */
export function hasAnswerTyping(kind: ChannelKind): boolean {
  return CHANNEL_ANSWERING[kind].typing !== null
}

/** Adds the 💬 Answer button to any message an agent sends to `kind` (a Notification, a reply). */
export function withAnswerButton<T extends { buttons?: KeyboardButton[][] }>(
  kind: ChannelKind,
  message: T,
  label: string,
): T {
  if (answerGesture(kind) !== 'button') return message
  const answer: KeyboardButton = { text: label, callbackData: ANSWER_CALLBACK }
  return { ...message, buttons: [...(message.buttons ?? []), [answer]] }
}
