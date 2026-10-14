import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'

// Central human-in-the-loop confirmation sink. Mirrors the error/activity sinks
// (store/errors.ts, store/activities.ts): a tool that needs explicit user approval
// pushes a pending confirmation here and awaits the returned promise; the chat UI
// renders an inline card for the active conversation and resolves it.
//
// Deliberately has NO store dependencies (like `errors`, `activities`, `ui`) to
// avoid circular imports — producers push, consumers read. At most one pending
// confirmation per conversation (a new request supersedes an older one).
// Main hears about every open card: a Turn Queue member of that conversation
// gives up its place while the user decides (a Paused Session).

export type ConfirmationOrigin = 'desktop' | 'remote'

export type PendingConfirmation = {
  id: string
  conversationKey: string
  toolCallId?: string
  title: string
  summaryMarkdown: string
  origin: ConfirmationOrigin
  // For `origin: 'remote'`, the channel the question was also posted to (e.g.
  // 'telegram'), so the mirrored desktop card can explain itself.
  channelLabel?: string
}

export type ConfirmationRequest = Omit<PendingConfirmation, 'id'>

function newId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `confirm-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function tellMain(conversationKey: string, waiting: boolean): void {
  globalThis.window?.electronAPI?.permissions?.awaitingUser?.(conversationKey, waiting)
}

export const useConfirmations = defineStore('confirmations', () => {
  const items = ref<PendingConfirmation[]>([])
  // id -> resolver; kept out of the reactive ref so the promise plumbing never
  // leaks into rendered state.
  const resolvers = new Map<string, (_answer: boolean) => void>()

  function request(input: ConfirmationRequest): Promise<boolean> {
    // One pending confirmation per conversation: settle any earlier one as
    // declined so a stale card can never linger.
    cancelForConversation(input.conversationKey, false)
    const id = newId()
    const pending: PendingConfirmation = { ...input, id }
    items.value = [...items.value, pending]
    tellMain(input.conversationKey, true)
    return new Promise<boolean>((resolve) => {
      resolvers.set(id, resolve)
    })
  }

  // Settle + remove. Idempotent: a second call for an already-settled id is a
  // no-op, so racing desktop/channel/timeout paths can all call it safely.
  function resolve(id: string, answer: boolean): void {
    const resolver = resolvers.get(id)
    if (!resolver) return
    resolvers.delete(id)
    const settled = items.value.find((item) => item.id === id)
    items.value = items.value.filter((item) => item.id !== id)
    if (settled) tellMain(settled.conversationKey, false)
    resolver(answer)
  }

  function forConversation(conversationKey: string): PendingConfirmation | null {
    // Innermost ~= most recent for this conversation.
    const matches = items.value.filter((item) => item.conversationKey === conversationKey)
    return matches.length > 0 ? matches[matches.length - 1] : null
  }

  function cancelForConversation(conversationKey: string, answer: boolean): void {
    const matches = items.value.filter((item) => item.conversationKey === conversationKey)
    matches.forEach((item) => resolve(item.id, answer))
  }

  return {
    items,
    request,
    resolve,
    forConversation,
    cancelForConversation,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConfirmations, import.meta.hot))
}
