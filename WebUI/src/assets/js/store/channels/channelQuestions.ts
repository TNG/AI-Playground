import { parseConfirmationReply } from '../confirmationReply'
import type { ChannelAdapter } from './adapter'
import type { ChannelKind, ChannelMessageRef, InboundMeta, KeyboardButton } from './types'

// Telegram caps callback_data at 64 bytes, so the id stays short.
const CALLBACK_RE = /^confirm:([a-z0-9]{1,16}):(yes|no)$/

export type ChannelQuestionAsk = {
  adapter: ChannelAdapter
  meta?: InboundMeta
  summaryMarkdown: string
  /** Home Agent in-turn confirmations: a typed yes/no answers, anything else typed declines. */
  typedReply?: boolean
  /** Declines after this long; omitted means the question stays open until settled. */
  timeoutMs?: number
  /** Runs before the buttons are sent (freezes a streaming draft above the prompt). */
  beforeSend?: () => Promise<void>
}

export type ChannelQuestion = { id: string; answer: Promise<boolean> }

export type InboundAnswer = { text?: string; callback?: string }

export type ChannelQuestionRegistry = {
  ask: (question: ChannelQuestionAsk) => ChannelQuestion
  /** Settles an open question and edits its buttons into the outcome; false if it was not open. */
  settle: (id: string, answer: boolean, outcomeNote?: string) => boolean
  isOpen: (id: string) => boolean
  /** True when the message answered a question and must not reach the Home Agent. */
  handleInbound: (kind: ChannelKind, msg: InboundAnswer) => boolean
}

type OpenQuestion = {
  adapter: ChannelAdapter
  meta?: InboundMeta
  summaryMarkdown: string
  typedReply: boolean
  resolve: (answer: boolean) => void
  timeoutId?: ReturnType<typeof setTimeout>
  ref?: ChannelMessageRef
}

function randomId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('')
}

export function confirmCallback(id: string, answer: boolean): string {
  return `confirm:${id}:${answer ? 'yes' : 'no'}`
}

export function createChannelQuestionRegistry(deps?: {
  newId?: () => string
  log?: (message: string, error: unknown) => void
}): ChannelQuestionRegistry {
  const newId = deps?.newId ?? randomId
  const log = deps?.log ?? ((message, error) => console.error(message, error))
  const open = new Map<string, OpenQuestion>()

  function editInPlace(q: OpenQuestion, outcome: string): void {
    if (!q.ref) return
    q.adapter
      .editKeyboardMessage(
        q.ref,
        q.adapter.formatMarkdown(`${q.summaryMarkdown}\n\n${outcome}`),
        q.meta,
      )
      .catch((e: unknown) => log('channelQuestions: settle edit failed:', e))
  }

  function settle(id: string, answer: boolean, outcomeNote?: string): boolean {
    const q = open.get(id)
    if (!q) return false
    open.delete(id)
    clearTimeout(q.timeoutId)
    editInPlace(q, outcomeNote ?? (answer ? '✅ Confirmed.' : '❌ Cancelled.'))
    q.resolve(answer)
    return true
  }

  function expire(id: string): void {
    const q = open.get(id)
    if (!q) return
    open.delete(id)
    const outcome = '⌛ No response — cancelled.'
    if (q.ref) editInPlace(q, outcome)
    else
      q.adapter
        .reply(q.adapter.formatRichSnippet(outcome), q.meta)
        .catch((e: unknown) => log('channelQuestions: timeout reply failed:', e))
    q.resolve(false)
  }

  function ask(question: ChannelQuestionAsk): ChannelQuestion {
    const { adapter, meta, summaryMarkdown } = question
    let id = newId()
    while (open.has(id)) id = newId()
    const answer = new Promise<boolean>((resolve) => {
      const entry: OpenQuestion = {
        adapter,
        meta,
        summaryMarkdown,
        typedReply: question.typedReply === true,
        resolve,
      }
      if (question.timeoutMs !== undefined) {
        entry.timeoutId = setTimeout(() => expire(id), question.timeoutMs)
      }
      open.set(id, entry)
      const buttons: KeyboardButton[][] = [
        [
          { text: '✅ Confirm', callbackData: confirmCallback(id, true) },
          { text: '✖ Cancel', callbackData: confirmCallback(id, false) },
        ],
      ]
      ;(async () => {
        try {
          await question.beforeSend?.()
        } catch (e) {
          log('channelQuestions: beforeSend failed:', e)
        }
        try {
          const res = await adapter.keyboard(adapter.formatMarkdown(summaryMarkdown), buttons, meta)
          // The user may answer before the send round-trips.
          if (res.ref && open.get(id) === entry) entry.ref = res.ref
        } catch (e) {
          log('channelQuestions: prompt send failed:', e)
        }
      })()
    })
    return { id, answer }
  }

  function handleInbound(kind: ChannelKind, msg: InboundAnswer): boolean {
    if (msg.callback) {
      const match = CALLBACK_RE.exec(msg.callback)
      if (!match) return false
      const q = open.get(match[1])
      if (!q || q.adapter.kind !== kind) return false
      return settle(match[1], match[2] === 'yes')
    }
    const typed = [...open].filter(([, q]) => q.typedReply && q.adapter.kind === kind)
    if (typed.length === 0) return false
    const answer = parseConfirmationReply(msg.text ?? '')
    for (const [id] of typed) settle(id, answer ?? false)
    return answer !== null
  }

  return { ask, settle, isOpen: (id) => open.has(id), handleInbound }
}
