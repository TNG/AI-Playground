import type { ChannelKind } from '@/assets/js/store/channels/types'

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
  text: string,
  replyTo?: string,
) => Promise<DraftEditOutcome>

export type ReplyDraft = {
  update: (text: string) => void
  /** Stops editing; resolves with the draft the final message settles, or null when none was shown. */
  close: () => Promise<ChannelDraft | null>
}

export type ReplyDraftOptions = {
  edit: DraftEdit
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

/** One edit budget per chat, shared by its open drafts. */
type Chat = {
  kind: ChannelKind
  drafts: Draft[]
  next: number
  lastEditAt: number
  timer: NodeJS.Timeout | null
  busy: boolean
}

const chats = new Map<ChannelKind, Chat>()
let lastDraftId = Date.now() % 0x3fffffff

function chatOf(kind: ChannelKind): Chat {
  let chat = chats.get(kind)
  if (!chat) {
    chat = { kind, drafts: [], next: 0, lastEditAt: -Infinity, timer: null, busy: false }
    chats.set(kind, chat)
  }
  return chat
}

function pending(chat: Chat): Draft[] {
  return chat.drafts.filter((draft) => draft.wanted && draft.wanted !== draft.shown)
}

function pump(chat: Chat): void {
  if (chat.timer || chat.busy || pending(chat).length === 0) return
  const wait = Math.max(0, chat.lastEditAt + EDIT_INTERVAL_MS[chat.kind] - Date.now())
  chat.timer = setTimeout(() => {
    chat.timer = null
    editNext(chat)
  }, wait)
}

function editNext(chat: Chat): void {
  const due = pending(chat)
  if (due.length === 0) return
  const draft =
    chat.drafts.slice(chat.next).find((open) => due.includes(open)) ??
    chat.drafts.find((open) => due.includes(open))!
  chat.next = (chat.drafts.indexOf(draft) + 1) % chat.drafts.length
  const text = draft.wanted
  chat.busy = true
  chat.lastEditAt = draft.lastEditAt = Date.now()
  draft.inFlight = draft.options
    .edit(chat.kind, { ...draft.channelDraft }, text, draft.options.replyTo)
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
      chat.busy = false
      pump(chat)
    })
}

function keepAlive(chat: Chat, draft: Draft, interval: number): NodeJS.Timeout {
  return setInterval(() => {
    if (!draft.visible || Date.now() - draft.lastEditAt < interval) return
    draft.wanted = `${draft.base} ${SPINNER[draft.frame++ % SPINNER.length]}`
    pump(chat)
  }, interval / 4)
}

/** A reply that streams into one message on `kind` until its final text settles it. */
export function openReplyDraft(kind: ChannelKind, options: ReplyDraftOptions): ReplyDraft {
  const chat = chatOf(kind)
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
  chat.drafts.push(draft)
  const interval = KEEPALIVE_MS[kind]
  if (interval) draft.keepAlive = keepAlive(chat, draft, interval)
  let closed = false
  return {
    update: (text) => {
      if (closed || text === draft.base) return
      draft.base = draft.wanted = text
      pump(chat)
    },
    close: async () => {
      if (!closed) {
        closed = true
        if (draft.keepAlive) clearInterval(draft.keepAlive)
        const index = chat.drafts.indexOf(draft)
        chat.drafts.splice(index, 1)
        if (chat.next > index) chat.next -= 1
        if (chat.drafts.length === 0 && chat.timer) {
          clearTimeout(chat.timer)
          chat.timer = null
        }
      }
      await draft.inFlight
      // The final message spends the chat's budget too.
      chat.lastEditAt = Date.now()
      return draft.visible ? { ...draft.channelDraft } : null
    },
  }
}
