import type { ChannelMessageOwner } from '@/types/notificationsIpc'
import type { StartableAgent } from './answerRouter'
import type { ChannelKind, ChannelMessageRef } from './types'

/** A posted Start Prompt Request: its first reply starts `agent` in `sessionRef`. */
export type StartPromptRequest = {
  agent: StartableAgent
  sessionRef: string
  /** The posted message, for marking it used. */
  message: ChannelMessageRef
}

/**
 * What a reply's message reference names: an open request, one whose reply's start waits in the
 * Session's queue, one a reply already used, or one posted before a restart, which only the
 * message map still knows.
 */
export type StartPromptLookup =
  | { state: 'open' | 'queued'; request: StartPromptRequest }
  | { state: 'used' }
  | { state: 'expired' }

/** The kernel's channel message map, which outlives a restart. */
export type StartPromptMessageMap = {
  record: (kind: ChannelKind, ref: string) => Promise<void>
  lookup: (kind: ChannelKind, ref: string) => Promise<ChannelMessageOwner | null>
}

/** The Start Prompt Requests posted on each Channel, keyed by the platform ref a reply names. */
export type StartPromptRequests = {
  open: (kind: ChannelKind, ref: string, request: StartPromptRequest) => Promise<void>
  /** Null when `ref` is no Start Prompt Request. */
  lookup: (kind: ChannelKind, ref: string) => Promise<StartPromptLookup | null>
  /** A reply's start is on its way; a dropped one reopens the request. */
  hold: (kind: ChannelKind, ref: string) => void
  reopen: (kind: ChannelKind, ref: string) => void
  markUsed: (kind: ChannelKind, ref: string) => void
}

/** The ref a reply to this message names: Telegram's and LAN chat's id, or Slack's ts. */
export function replyRefOf(message: ChannelMessageRef | undefined): string | null {
  if (typeof message?.messageId === 'number') return String(message.messageId)
  return message?.ts ?? null
}

/** Held in memory only, like queued messages (ADR 0002): after a restart they are expired. */
export function createStartPromptRequests(messageMap: StartPromptMessageMap): StartPromptRequests {
  const entries = new Map<string, StartPromptLookup>()
  const key = (kind: ChannelKind, ref: string) => `${kind}:${ref}`
  return {
    open: async (kind, ref, request) => {
      entries.set(key(kind, ref), { state: 'open', request })
      await messageMap.record(kind, ref)
    },
    lookup: async (kind, ref) => {
      const held = entries.get(key(kind, ref))
      if (held) return held
      const owner = await messageMap.lookup(kind, ref)
      return owner && 'startPromptRequest' in owner ? { state: 'expired' } : null
    },
    hold: (kind, ref) => {
      const held = entries.get(key(kind, ref))
      if (held?.state === 'open') entries.set(key(kind, ref), { ...held, state: 'queued' })
    },
    reopen: (kind, ref) => {
      const held = entries.get(key(kind, ref))
      if (held?.state === 'queued') entries.set(key(kind, ref), { ...held, state: 'open' })
    },
    markUsed: (kind, ref) => {
      if (entries.has(key(kind, ref))) entries.set(key(kind, ref), { state: 'used' })
    },
  }
}
