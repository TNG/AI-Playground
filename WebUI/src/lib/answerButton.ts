import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'

/** The callback of the 💬 Answer button; the tapped message itself names the session. */
export const ANSWER_CALLBACK = 'answer'

/** How a channel answers an agent's message, and how a send there names the message it replies to. */
type ChannelAnswering = {
  /** `button`: the 💬 Answer button (Telegram's Answer Prompt, LAN chat's composer chip); `thread`: replying in its thread. */
  gesture: 'button' | 'thread' | null
  replyKey: string
  /** The LAN page's chip names the session, so its button carries the title. */
  buttonCarriesTitle: boolean
  /** A LAN chat `reply` settles the streaming Home Agent bubble; `post` stands on its own. */
  sendsAsPost: boolean
  /** Main can show "typing…" while the turn an Answer started runs. */
  answerTyping: boolean
  /** Typing is ended by an explicit stop rather than by lapsing. */
  typingStops: boolean
}

export const CHANNEL_ANSWERING: Record<ChannelKind, ChannelAnswering> = {
  telegram: {
    gesture: 'button',
    replyKey: 'reply_to_message_id',
    buttonCarriesTitle: false,
    sendsAsPost: false,
    answerTyping: true,
    typingStops: false,
  },
  slack: {
    gesture: 'thread',
    replyKey: 'thread_ts',
    buttonCarriesTitle: false,
    sendsAsPost: false,
    answerTyping: false,
    typingStops: false,
  },
  'local-web': {
    gesture: 'button',
    replyKey: 'reply_to',
    buttonCarriesTitle: true,
    sendsAsPost: true,
    answerTyping: true,
    typingStops: true,
  },
  discord: {
    gesture: null,
    replyKey: 'reply_to',
    buttonCarriesTitle: false,
    sendsAsPost: false,
    answerTyping: false,
    typingStops: false,
  },
}

export function hasAnswerButton(kind: ChannelKind): boolean {
  return CHANNEL_ANSWERING[kind].gesture === 'button'
}

/** Whether the turn an Answer started shows "typing…", which then acknowledges the Answer. */
export function hasAnswerTyping(kind: ChannelKind): boolean {
  return CHANNEL_ANSWERING[kind].answerTyping
}

export function answersInThread(kind: ChannelKind): boolean {
  return CHANNEL_ANSWERING[kind].gesture === 'thread'
}

/** Adds the 💬 Answer button to any message an agent sends to `kind` (a Notification, a reply). */
export function withAnswerButton<T extends { buttons?: KeyboardButton[][] }>(
  kind: ChannelKind,
  message: T,
  label: string,
): T {
  if (!hasAnswerButton(kind)) return message
  const answer: KeyboardButton = { text: label, callbackData: ANSWER_CALLBACK }
  return { ...message, buttons: [...(message.buttons ?? []), [answer]] }
}
