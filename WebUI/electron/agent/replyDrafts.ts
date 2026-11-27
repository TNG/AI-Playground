import type { ChannelKind } from '@/assets/js/store/channels/types'
import type { ChannelText } from './channelText.ts'

/**
 * An open draft on a Channel: Telegram's and LAN chat's draft id, and once its first
 * edit has posted it, Slack's message `ref` (ts) and `chat` (the conversation it is in).
 */
export type ChannelDraft = { id: number; ref?: string; chat?: string }

export type DraftEditOutcome =
  { success: true; ref?: string; chat?: string } | { success: false; error: string }

/** Shows `text` in `draft`, creating the message on the first edit where the Channel needs one. */
export type DraftEdit = (
  kind: ChannelKind,
  draft: ChannelDraft,
  text: ChannelText,
  replyTo?: string,
) => Promise<DraftEditOutcome>

export type ReplyDraft = {
  update: (text: string) => void
  /** Stops editing; resolves with the draft the final message settles, or null when none was shown. */
  close: () => Promise<ChannelDraft | null>
}

export type ReplyDraftOptions = {
  edit: DraftEdit
  header?: string
  replyTo?: string
  /** The message an edit created, to record it as the Session's. */
  onPosted?: (ref: string) => void
}

// Telegram allows about one message a second per chat, Slack's chat.update about 50 a
// minute; LAN chat is our own page.
const EDIT_INTERVAL_MS: Record<ChannelKind, number> = {
  telegram: 1000,
  slack: 1200,
  'local-web': 250,
  discord: 1000,
}

// Telegram drops a draft it has not heard about for 30 s.
const KEEPALIVE_MS: Partial<Record<ChannelKind, number>> = { telegram: 20_000 }
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

type Draft = {
  options: ReplyDraftOptions
  channelDraft: ChannelDraft
  base: string
  wanted: string
  shown: string
  visible: boolean
  lastEditAt: number
  inFlight: Promise<void> | null
  keepAlive: NodeJS.Timeout | null
  frame: number
}

/** Each Channel chat's edit budget, shared by its open drafts. */
type EditBudget = {
  kind: ChannelKind
  drafts: Draft[]
  next: number
  lastEditAt: number
  timer: NodeJS.Timeout | null
  busy: boolean
}

const budgets = new Map<ChannelKind, EditBudget>()
let lastDraftId = Date.now() % 0x3fffffff

function budgetOf(kind: ChannelKind): EditBudget {
  let budget = budgets.get(kind)
  if (!budget) {
    budget = { kind, drafts: [], next: 0, lastEditAt: -Infinity, timer: null, busy: false }
    budgets.set(kind, budget)
  }
  return budget
}

function pending(budget: EditBudget): Draft[] {
  return budget.drafts.filter((draft) => draft.wanted && draft.wanted !== draft.shown)
}

function pump(budget: EditBudget): void {
  if (budget.timer || budget.busy || pending(budget).length === 0) return
  const wait = Math.max(0, budget.lastEditAt + EDIT_INTERVAL_MS[budget.kind] - Date.now())
  budget.timer = setTimeout(() => {
    budget.timer = null
    editNext(budget)
  }, wait)
}

function editNext(budget: EditBudget): void {
  const due = pending(budget)
  if (due.length === 0) return
  const draft =
    budget.drafts.slice(budget.next).find((open) => due.includes(open)) ??
    budget.drafts.find((open) => due.includes(open))!
  budget.next = (budget.drafts.indexOf(draft) + 1) % budget.drafts.length
  const text = draft.wanted
  const { header, replyTo } = draft.options
  budget.busy = true
  budget.lastEditAt = draft.lastEditAt = Date.now()
  draft.inFlight = draft.options
    .edit(budget.kind, { ...draft.channelDraft }, { header, text }, replyTo)
    .then((outcome) => {
      if (!outcome.success) return
      draft.visible = true
      if (outcome.ref && !draft.channelDraft.ref) {
        draft.channelDraft.ref = outcome.ref
        if (outcome.chat) draft.channelDraft.chat = outcome.chat
        draft.options.onPosted?.(outcome.ref)
      }
    })
    .catch(() => {})
    .finally(() => {
      draft.shown = text
      draft.inFlight = null
      budget.busy = false
      pump(budget)
    })
}

function keepAlive(budget: EditBudget, draft: Draft, interval: number): NodeJS.Timeout {
  return setInterval(() => {
    if (!draft.visible || Date.now() - draft.lastEditAt < interval) return
    draft.wanted = `${draft.base} ${SPINNER[draft.frame++ % SPINNER.length]}`
    pump(budget)
  }, interval / 4)
}

/** A reply that streams into one message on `kind` until its final text settles it. */
export function openReplyDraft(kind: ChannelKind, options: ReplyDraftOptions): ReplyDraft {
  const budget = budgetOf(kind)
  lastDraftId = (lastDraftId % 0x7ffffffe) + 1
  const draft: Draft = {
    options,
    channelDraft: { id: lastDraftId },
    base: '',
    wanted: '',
    shown: '',
    visible: false,
    lastEditAt: 0,
    inFlight: null,
    keepAlive: null,
    frame: 0,
  }
  budget.drafts.push(draft)
  const interval = KEEPALIVE_MS[kind]
  if (interval) draft.keepAlive = keepAlive(budget, draft, interval)
  let closed = false
  return {
    update: (text) => {
      if (closed || text === draft.base) return
      draft.base = draft.wanted = text
      pump(budget)
    },
    close: async () => {
      if (!closed) {
        closed = true
        if (draft.keepAlive) clearInterval(draft.keepAlive)
        const index = budget.drafts.indexOf(draft)
        budget.drafts.splice(index, 1)
        if (budget.next > index) budget.next -= 1
        if (budget.drafts.length === 0 && budget.timer) {
          clearTimeout(budget.timer)
          budget.timer = null
        }
      }
      await draft.inFlight
      // The final message spends the chat's budget too.
      budget.lastEditAt = Date.now()
      return draft.visible ? { ...draft.channelDraft } : null
    },
  }
}
