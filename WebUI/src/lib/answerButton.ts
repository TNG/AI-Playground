import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'

/** The callback of the 💬 Answer button; the tapped message itself names the session. */
export const ANSWER_CALLBACK = 'answer'

type AnswerGesture = 'button' | 'thread' | 'reply'

/** How a channel answers an agent's message, and how a send there names the message it replies to. */
type ChannelAnswering = {
  /** `button`: the 💬 Answer button (LAN chat's composer chip); `thread`: replying in its thread; `reply`: replying to the message. */
  gesture: AnswerGesture | null
  replyKey: string
  /** The LAN page's chip names the session, so its button carries the title. */
  buttonCarriesTitle: boolean
  /** A LAN chat `reply` settles the streaming Home Agent bubble; `post` stands on its own. */
  sendsAsPost: boolean
}

export const CHANNEL_ANSWERING: Record<ChannelKind, ChannelAnswering> = {
  telegram: {
    gesture: 'reply',
    replyKey: 'reply_to_message_id',
    buttonCarriesTitle: false,
    sendsAsPost: false,
  },
  slack: {
    gesture: 'thread',
    replyKey: 'thread_ts',
    buttonCarriesTitle: false,
    sendsAsPost: false,
  },
  'local-web': {
    gesture: 'button',
    replyKey: 'reply_to',
    buttonCarriesTitle: true,
    sendsAsPost: true,
  },
  discord: { gesture: null, replyKey: 'reply_to', buttonCarriesTitle: false, sendsAsPost: false },
}

export function answerGesture(kind: ChannelKind): AnswerGesture | null {
  return CHANNEL_ANSWERING[kind].gesture
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
