import { parseConfirmationReply } from '../confirmationReply'
import type { ChannelAdapter } from './adapter'
import type { ChannelKind, ChannelMessageRef, InboundMeta, KeyboardButton } from './types'

// Telegram caps callback_data at 64 bytes, so the id stays short.
const CALLBACK_RE = /^confirm:([a-z0-9]{1,16}):(yes|no)$/

const STALE_REPLY = 'This question is no longer open. Use AI Playground on your computer.'

export type ChannelQuestionLabels = {
  confirm: string
  cancel: string
  confirmed: string
  cancelled: string
}

const ENGLISH_LABELS: ChannelQuestionLabels = {
  confirm: '✅ Confirm',
  cancel: '✖ Cancel',
  confirmed: '✅ Confirmed.',
  cancelled: '❌ Cancelled.',
}

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
  /** Button texts and the notes a tap leaves; English when omitted. */
  labels?: ChannelQuestionLabels
}

export type ChannelQuestion = { id: string; answer: Promise<boolean> }

export type InboundAnswer = { text?: string; callback?: string }

export type ChannelQuestionRegistry = {
  ask: (question: ChannelQuestionAsk) => ChannelQuestion
  /** Settles an open question and edits its buttons into the outcome; false if it was not open. */
  settle: (id: string, answer: boolean, outcomeNote?: string) => boolean
  /** Takes an open question's buttons away with a note; its `answer` never resolves. */
  retire: (id: string, note: string) => boolean
  /** Retires every button-only Channel Question not asked on `kind` (all of them for `null`). */
  retireOutside: (kind: ChannelKind | null, note: string) => void
  isOpen: (id: string) => boolean
  /** True when the message answered a question, or tapped a closed one, and must not reach the Home Agent. */
  handleInbound: (adapter: ChannelAdapter, msg: InboundAnswer, meta?: InboundMeta) => boolean
}

type OpenQuestion = {
  adapter: ChannelAdapter
  meta?: InboundMeta
  summaryMarkdown: string
  typedReply: boolean
  labels: ChannelQuestionLabels
  resolve: (answer: boolean) => void
  timeoutId?: ReturnType<typeof setTimeout>
  ref?: ChannelMessageRef
  /** Set once settled, so a send that lands afterwards still loses its buttons. */
  outcome?: string
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
  staleReply?: () => string
}): ChannelQuestionRegistry {
  const newId = deps?.newId ?? randomId
  const staleReply = deps?.staleReply ?? (() => STALE_REPLY)
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
    q.outcome = outcomeNote ?? (answer ? q.labels.confirmed : q.labels.cancelled)
    editInPlace(q, q.outcome)
    q.resolve(answer)
    return true
  }

  function retire(id: string, note: string): boolean {
    const q = open.get(id)
    if (!q) return false
    open.delete(id)
    clearTimeout(q.timeoutId)
    q.outcome = note
    editInPlace(q, note)
    return true
  }

  function retireOutside(kind: ChannelKind | null, note: string): void {
    for (const [id, q] of [...open]) {
      if (!q.typedReply && q.adapter.kind !== kind) retire(id, note)
    }
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
    const labels = question.labels ?? ENGLISH_LABELS
    let id = newId()
    while (open.has(id)) id = newId()
    const answer = new Promise<boolean>((resolve) => {
      const entry: OpenQuestion = {
        adapter,
        meta,
        summaryMarkdown,
        typedReply: question.typedReply === true,
        labels,
        resolve,
      }
      if (question.timeoutMs !== undefined) {
        entry.timeoutId = setTimeout(() => expire(id), question.timeoutMs)
      }
      open.set(id, entry)
      const buttons: KeyboardButton[][] = [
        [
          { text: labels.confirm, callbackData: confirmCallback(id, true) },
          { text: labels.cancel, callbackData: confirmCallback(id, false) },
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
          // The question may be settled before the send round-trips.
          if (res.ref) {
            entry.ref = res.ref
            if (entry.outcome !== undefined) editInPlace(entry, entry.outcome)
          }
        } catch (e) {
          log('channelQuestions: prompt send failed:', e)
        }
      })()
    })
    return { id, answer }
  }

  function handleInbound(adapter: ChannelAdapter, msg: InboundAnswer, meta?: InboundMeta): boolean {
    const kind = adapter.kind
    if (msg.callback) {
      if (!msg.callback.startsWith('confirm:')) return false
      const match = CALLBACK_RE.exec(msg.callback)
      const q = match ? open.get(match[1]) : undefined
      if (match && q && q.adapter.kind === kind) return settle(match[1], match[2] === 'yes')
      adapter
        .reply(adapter.formatRichSnippet(staleReply()), meta)
        .catch((e: unknown) => log('channelQuestions: stale-tap reply failed:', e))
      return true
    }
    const typed = [...open].filter(([, q]) => q.typedReply && q.adapter.kind === kind)
    if (typed.length === 0) return false
    const answer = parseConfirmationReply(msg.text ?? '')
    for (const [id] of typed) settle(id, answer ?? false)
    return answer !== null
  }

  return { ask, settle, retire, retireOutside, isOpen: (id) => open.has(id), handleInbound }
}
