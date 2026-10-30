import type { BrowserWindow } from 'electron'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AgentToolAccess } from './piToolOperations.ts'
import type { PlanningEnd } from './planningPhase.ts'
import type { InferenceTraceContext } from '../observability/laminarAttributes.ts'

export type ActiveSession = {
  configKey: string
  sessionId: string
  /** Resolved (realpath) workspace folder — the key for session persistence. */
  workspaceDir: string
  session: AgentSession
  access: AgentToolAccess
  /** Preview URL the session's instructions were built with. */
  instructedBaseUrl: string | null
  unsubscribe: () => void
  /**
   * The sampling bag the live model holds. Pi re-reads it per request, so
   * `planningPhase.ts` can end thinking mid-turn by mutating it.
   */
  samplingParams?: Record<string, unknown>
  /** The session's trace context, re-applied whenever its turn takes the place back. */
  traceContext: () => InferenceTraceContext
  /**
   * What ends this session's thinking phase, or null when it thinks throughout
   * (the user's setting, or a capability with no plan step of its own).
   */
  planningEnd: PlanningEnd | null
  /**
   * The build request that follows the plan, for a session whose first turn is
   * split in two (`AgentCapability.planHandoff`). Null for every other session.
   */
  planHandoff: string | null
  /** Whether the plan step is still ahead: true until the first turn has run. */
  planPending: boolean
}

/** One agent turn main holds open, from submission until it settles. */
export type AgentTurn = {
  sessionId: string
  turnId: string
  abort: AbortController
  /** The live Pi session the turn runs on, once it has been readied. */
  live: ActiveSession | null
  onEvent?: (event: AgentSessionEvent) => void
  /** Host-side text (an extension's slash command output) for the transcript. */
  notice?: (text: string) => void
  /** Takes back a Turn Queue place given up while paused; resolves at once otherwise. */
  reclaim?: () => Promise<void>
}

export let mainWin: BrowserWindow | null = null
/**
 * The live session the next turn reuses. A session whose turn is paused is not
 * here once another turn has built its own; that turn's `live` keeps it alive.
 */
export let active: ActiveSession | null = null
export let lastSessionId: string | null = null
/** Open agent turns, keyed by the Agent Session they belong to. */
export const agentTurns = new Map<string, AgentTurn>()

export function setMainWin(win: BrowserWindow | null): void {
  mainWin = win
}

export function setActive(next: ActiveSession | null): void {
  active = next
}

export function setLastSessionId(id: string | null): void {
  lastSessionId = id
}
