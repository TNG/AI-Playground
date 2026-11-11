import type { StartableAgent } from './answerRouter'
import type { ChannelKind, ChannelMessageRef } from './types'

/** A posted Start Prompt Request: its first reply starts `agent` in `sessionRef`. */
export type StartPromptRequest = {
  agent: StartableAgent
  sessionRef: string
  /** The posted message, for marking it used. */
  message: ChannelMessageRef
}

/** What a reply's message reference names: an open request, or one a reply already used. */
export type StartPromptLookup = { state: 'open'; request: StartPromptRequest } | { state: 'used' }

/** The Start Prompt Requests posted on each Channel, keyed by the platform ref a reply names. */
export type StartPromptRequests = {
  open: (kind: ChannelKind, ref: string, request: StartPromptRequest) => Promise<void>
  /** Null when `ref` is no Start Prompt Request. */
  lookup: (kind: ChannelKind, ref: string) => Promise<StartPromptLookup | null>
  markUsed: (kind: ChannelKind, ref: string) => void
}

/** The ref a reply to this message names: Telegram's and LAN chat's id, or Slack's ts. */
export function replyRefOf(message: ChannelMessageRef | undefined): string | null {
  if (typeof message?.messageId === 'number') return String(message.messageId)
  return message?.ts ?? null
}

/** Held in memory only, like queued messages (ADR 0002): a restart forgets them. */
export function createStartPromptRequests(): StartPromptRequests {
  const entries = new Map<string, StartPromptLookup>()
  const key = (kind: ChannelKind, ref: string) => `${kind}:${ref}`
  return {
    open: async (kind, ref, request) => {
      entries.set(key(kind, ref), { state: 'open', request })
    },
    lookup: async (kind, ref) => entries.get(key(kind, ref)) ?? null,
    markUsed: (kind, ref) => {
      if (entries.has(key(kind, ref))) entries.set(key(kind, ref), { state: 'used' })
    },
  }
}
