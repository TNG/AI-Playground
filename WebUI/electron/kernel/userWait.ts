// ── Questions to the user, attributed to the turn they hold up ────────────────
//
// A Turn Queue member that waits on the user gives up its place (orchestrator
// `beginUserWait`). Most such waits are asked by main itself on behalf of a known
// conversation; a download prompt the renderer starts in the middle of answering
// a turn's request (a speech tool's voice model, the rag tool's embedding model)
// arrives with no conversation attached. That one is attributed to the turn whose
// renderer request is outstanding, preferring the member that holds the place.

import type { PauseReason } from '@/types/kernelEvents'

/** What this module needs from the Turn Queue; the orchestrator registers it as it loads. */
export type UserWaitQueue = {
  beginUserWait(conversationKey: string, reason?: PauseReason): () => void
  hasPausableRun(conversationKey: string): boolean
  turnHolderConversationKey(): string | undefined
}

// Registered rather than imported, so the modules that ask the window (chat:ask,
// the tool bridge, the permission prompts) stay free of the orchestrator's imports.
let queue: UserWaitQueue | null = null

export function registerUserWaitQueue(next: UserWaitQueue): void {
  queue = next
}

const openWaits = new Map<string, number>()
type UserWaitListener = (conversationKey: string, waiting: boolean) => void
const listeners = new Set<UserWaitListener>()

/** Hears when `conversationKey` starts waiting on the user, and when the last of its waits ends. */
export function onUserWaitChange(listener: UserWaitListener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function isWaitingOnUser(conversationKey: string): boolean {
  return openWaits.has(conversationKey)
}

function beginUserWait(conversationKey: string, reason?: PauseReason): () => void {
  const answeredInQueue = queue ? queue.beginUserWait(conversationKey, reason) : () => {}
  const open = (openWaits.get(conversationKey) ?? 0) + 1
  openWaits.set(conversationKey, open)
  if (open === 1) for (const listener of listeners) listener(conversationKey, true)
  let ended = false
  return () => {
    if (ended) return
    ended = true
    answeredInQueue()
    const left = (openWaits.get(conversationKey) ?? 1) - 1
    if (left > 0) {
      openWaits.set(conversationKey, left)
      return
    }
    openWaits.delete(conversationKey)
    for (const listener of listeners) listener(conversationKey, false)
  }
}

const rendererCalls = new Map<string, number>()
const rendererWaits = new Map<string, Array<() => void>>()

/** Runs a request a turn of `conversationKey` makes to the window, so prompts it raises are its own. */
export async function whileRendererAnswers<T>(
  conversationKey: string | undefined,
  call: () => Promise<T>,
): Promise<T> {
  if (!conversationKey) return call()
  rendererCalls.set(conversationKey, (rendererCalls.get(conversationKey) ?? 0) + 1)
  try {
    return await call()
  } finally {
    const left = (rendererCalls.get(conversationKey) ?? 1) - 1
    if (left > 0) rendererCalls.set(conversationKey, left)
    else rendererCalls.delete(conversationKey)
  }
}

/** The conversation a prompt with no stated owner holds up, if one can be named. */
export function userWaitOwner(): string | undefined {
  if (!queue) return undefined
  const asking = [...rendererCalls.keys()].filter((key) => queue?.hasPausableRun(key))
  const holder = queue.turnHolderConversationKey()
  if (holder && asking.includes(holder)) return holder
  return asking.length === 1 ? asking[0] : undefined
}

/** Runs `wait` — something only the user can answer — as a pause of `conversationKey`'s turn. */
export async function awaitUser<T>(
  conversationKey: string | undefined,
  wait: () => Promise<T>,
  reason?: PauseReason,
): Promise<T> {
  const answered = conversationKey ? beginUserWait(conversationKey, reason) : () => {}
  try {
    return await wait()
  } finally {
    answered()
  }
}

/** The window shows (`true`) or settled (`false`) a card that asks the user for `conversationKey`. */
export function setAwaitingUser(
  conversationKey: string,
  waiting: boolean,
  reason?: PauseReason,
): void {
  const open = rendererWaits.get(conversationKey) ?? []
  if (waiting) {
    rendererWaits.set(conversationKey, [...open, beginUserWait(conversationKey, reason)])
    return
  }
  const [answered, ...rest] = open
  answered?.()
  if (rest.length > 0) rendererWaits.set(conversationKey, rest)
  else rendererWaits.delete(conversationKey)
}

/** The window that showed the cards is gone; none of them can be answered any more. */
export function clearRendererWaits(): void {
  for (const open of rendererWaits.values()) for (const answered of open) answered()
  rendererWaits.clear()
}

// Test seam.
export function resetUserWaitForTest(): void {
  rendererCalls.clear()
  rendererWaits.clear()
  openWaits.clear()
}
