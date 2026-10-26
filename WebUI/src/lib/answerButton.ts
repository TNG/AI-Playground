import type { ChannelKind, KeyboardButton } from '@/assets/js/store/channels/types'

/** The callback of the 💬 Answer button; the tapped message itself names the session. */
export const ANSWER_CALLBACK = 'answer'

/** Channels whose agent messages carry the button: Telegram opens an Answer Prompt, LAN chat a composer chip. */
const ANSWER_BUTTON_CHANNELS: readonly ChannelKind[] = ['telegram', 'local-web']

/** Channels where replying in a message's thread is the Answer, so they need no button. */
const THREAD_ANSWER_CHANNELS: readonly ChannelKind[] = ['slack']

export function hasAnswerButton(kind: ChannelKind): boolean {
  return ANSWER_BUTTON_CHANNELS.includes(kind)
}

export function answersInThread(kind: ChannelKind): boolean {
  return THREAD_ANSWER_CHANNELS.includes(kind)
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
