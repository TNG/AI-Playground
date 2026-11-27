import type { BrowserWindow } from 'electron'
import type { AgentSession, AgentSessionEvent } from '@earendil-works/pi-coding-agent'
import type { AgentToolAccess } from './piToolOperations.ts'
import type { PlanningEnd } from './planningPhase.ts'
import type { InferenceTraceContext } from '../observability/laminarAttributes.ts'
import type { HistoryReader } from '../session/historyArtifacts.ts'
import type { ResolvedMountedFolder } from '@/lib/mountedFolders'
import type { AgentFiles, AttachmentsFolder } from './workspaceAttachments.ts'
import type { TurnFolders } from './turnFolders.ts'

export type ActiveSession = {
  configKey: string
  sessionId: string
  /** Resolved (realpath) workspace folder — the key for session persistence. */
  workspaceDir: string
  /** What its file references resolve against, a Session's attachments included. */
  files: AgentFiles
  /** Its attachments, named the way this session's tools reach them. */
  attachments: AttachmentsFolder
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
  /** Whether the session offers `rag`, so its turns name the Session's documents. */
  documentSearch: boolean
  /** The realpathed folders this session's sandbox mounts: its Workspace and the rest. */
  folders: TurnFolders
  /** Every folder in the sandbox, its Workspace first when mounted at `/mnt`, as the change note compares them. */
  mountedFolders: ResolvedMountedFolder[]
  /** Pi's working directory: the Workspace's sandbox path, or its real path under the real shell. */
  workdir: string
  /** What changed in them since the conversation's last turn, for the next prompt only. */
  mountedFoldersNote?: string
  /** History Entries replayed into this session when it was created, as messages. */
  replayedEntryIds: string[]
  /** How its `session_history` and Session Updates name History Artifacts. */
  historyReader: HistoryReader
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
  /** Before each model request: stops a stopped turn, else takes back a place given up while paused. */
  beforeModelCall?: () => Promise<void>
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
