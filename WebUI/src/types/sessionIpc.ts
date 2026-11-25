import { z } from 'zod'
import { MountedFolderAccessSchema } from './agentSessionIpc'
import { ChatModelConfigSchema } from './chatIpc'

/**
 * A Session's `session.json` (ADR-0003). Everything the later tickets fill in
 * (display timeline, Session Settings, Harness Session pointers, Session Update
 * cursors) has a field from the start, defaulting empty, so the file never
 * needs a schema bump to grow into them. Timeline messages are opaque UI
 * messages, like a conversation file's.
 */
/** One folder of a Session's list; `slug` names it in the sandbox and never changes. */
export const SessionFolderEntrySchema = z.object({
  id: z.string().min(1),
  hostPath: z.string().min(1),
  access: MountedFolderAccessSchema,
  slug: z.string().regex(/^[A-Za-z0-9._-]+$/),
  /** The app made this folder for the Session, rather than the user picking it. */
  appCreated: z.boolean().optional(),
  /** Not on disk yet: the app creates it at the Session's first turn or when it is opened. */
  planned: z.boolean().optional(),
})
export type SessionFolderEntry = z.infer<typeof SessionFolderEntrySchema>

/** An Agent's own Workspace, registered at its first run in a Session (ADR 0014). */
export const AgentOwnedFolderEntrySchema = SessionFolderEntrySchema.extend({
  agentId: z.string().min(1).optional(),
})
export type AgentOwnedFolderEntry = z.infer<typeof AgentOwnedFolderEntrySchema>

/** A Session's folders and which of them is its Workspace (the starred entry). */
export type SessionFolderList = {
  folders: SessionFolderEntry[]
  workspaceId: string
  /** Folders taken off the list: not mounted or shown, but their Artifacts still resolve. */
  detached?: SessionFolderEntry[]
  /** Agents' own Workspaces: not on the Session's own list, but their Artifacts resolve. */
  agentOwned?: AgentOwnedFolderEntry[]
}

/** A starred user folder that no longer exists: renamed, deleted, or on an unplugged drive. */
export type MissingWorkspace = {
  folderId: string
  hostPath: string
  name: string
  /** The folder created for the Session, still on disk: what to go back to instead of a new one. */
  fallback?: { folderId: string }
}

export const HistoryEntryKindSchema = z.enum([
  'chat',
  'agent',
  'image',
  'edit',
  'video',
  'tts',
  'stt',
])

export const ArtifactMediaTypeSchema = z.enum(['image', 'video', 'audio', 'model3d'])

/** The stored account of a Session's whole work while it is Included in Overviews. */
export const OverviewSummaryStateSchema = z.enum(['pending', 'ready', 'failed'])
export type OverviewSummaryState = z.infer<typeof OverviewSummaryStateSchema>

/**
 * The newest visual Artifact an update judged still matches its account.
 * `path` is relative to `folderId` when there is one, and absolute otherwise
 * (a game's icon lives in the game folder, not a Session folder).
 */
export const OverviewSummaryPictureSchema = z.object({
  folderId: z.string().optional(),
  path: z.string().min(1),
  mediaType: ArtifactMediaTypeSchema,
  source: z.enum(['artifact', 'video-thumbnail', 'game-icon']),
})
export type OverviewSummaryPicture = z.infer<typeof OverviewSummaryPictureSchema>

export const OverviewSummarySchema = z.object({
  state: OverviewSummaryStateSchema,
  text: z.string().optional(),
  /** The newest History Entry the text covers; absent while nothing has been written. */
  coveredEntryId: z.string().optional(),
  /** The model that wrote the current text. */
  model: z.string().optional(),
  /** The Session's reply language when the text was written. */
  language: z.string().optional(),
  /** A materially changed summariser prompt bumps this to mark old summaries behind. */
  contractVersion: z.number().int().positive(),
  picture: OverviewSummaryPictureSchema.optional(),
  failureReason: z.string().optional(),
  writtenAt: z.number().int().nonnegative().optional(),
  /** Incremental updates since the last full rebuild; the periodic rebuild resets it. */
  updatesSinceRebuild: z.number().int().nonnegative().optional(),
})
export type OverviewSummary = z.infer<typeof OverviewSummarySchema>

/**
 * What one turn's Overview Summary update did, kept on its History Entry so the
 * turn's details row can show it. `pending` is written before the update runs
 * (durability); a cloud turn's entry stays pending because no local model ran.
 */
export const OverviewSummaryUpdateStateSchema = z.enum(['pending', 'ready', 'failed', 'skipped'])
export type OverviewSummaryUpdateState = z.infer<typeof OverviewSummaryUpdateStateSchema>

export const OverviewSummaryUpdateSchema = z.object({
  state: OverviewSummaryUpdateStateSchema,
  /** The model that wrote the text, or the model the failed attempt used. */
  model: z.string().optional(),
  /** When the update settled, and how long it took. */
  writtenAt: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
  tokens: z.number().int().nonnegative().optional(),
  /** The newest History Entry the text covered when this turn settled. */
  coveredEntryId: z.string().optional(),
  failureReason: z.string().optional(),
  text: z.string().optional(),
})
export type OverviewSummaryUpdate = z.infer<typeof OverviewSummaryUpdateSchema>

/** The per-turn outcome a details row reads, with the entry it belongs to and its prompt. */
export type OverviewTurnUpdate = {
  entryId: string
  kind: HistoryEntryKind
  prompt: string
  harnessSessionId?: string
  update: OverviewSummaryUpdate
}

/** What the renderer resolves for an activation or refresh: local model and reply language. */
export const OverviewSummaryRequestSchema = z.object({
  /** Absent when no local model is available; the summary stays pending and no call is made. */
  model: ChatModelConfigSchema.optional(),
  language: z.string().min(1),
})
export type OverviewSummaryRequest = z.infer<typeof OverviewSummaryRequestSchema>

export const SessionFileSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string(),
  /** Empty until the first prompt names the Session or the user renames it. */
  title: z.string(),
  /** Set once the user renames, so the first prompt no longer overwrites the title. */
  renamed: z.boolean().default(false),
  pinned: z.boolean().default(false),
  /** The Session Group it is in; one that no longer resolves lists as ungrouped. */
  groupId: z.string().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  presetsUsed: z.array(z.string()).default([]),
  timeline: z.array(z.unknown()).default([]),
  /** Session Settings, keyed by preset name. */
  settings: z.record(z.string(), z.unknown()).default({}),
  /** Harness Session id per agent preset. */
  harnessSessions: z.record(z.string(), z.string()).default({}),
  /** Game folder per games preset (Game Agent, Quick Coder); other presets work in `files/`. */
  harnessWorkspaces: z.record(z.string(), z.string()).default({}),
  /** Harness Sessions a hand-over replaced; still the Session's, so deleted with it. */
  retiredHarnessSessions: z.array(z.string()).default([]),
  /** One fresh Harness Session per Task Run; never resumed, deleted with the Session. */
  taskRunHarnessSessions: z.array(z.string()).default([]),
  /** Last History Entry id each Session Update consumer has seen. */
  updateCursors: z.record(z.string(), z.string()).default({}),
  /** The Agent picked in the prompt bar, run on Assistant; absent means Assistant itself. */
  pickedAgentId: z.string().optional(),
  /** Channels may send it messages and it may notify them (Reachable Session). */
  reachable: z.boolean().default(false),
  /** Its History Entries may appear in an Overview (Included in Overviews); off by default. */
  includedInOverviews: z.boolean().default(false),
  /** Its Overview Summary while it is included; absent on an old file or before anything is written. */
  overviewSummary: OverviewSummarySchema.optional(),
  /** Hidden messages stay in the file and in what the model sees; only the view drops them. */
  hiddenMessageIds: z.array(z.string()).default([]),
  /** Absent on a file written before the list existed; read through `sessionFolderListOf`. */
  folders: z.array(SessionFolderEntrySchema).optional(),
  workspaceFolderId: z.string().optional(),
  detachedFolders: z.array(SessionFolderEntrySchema).optional(),
  agentFolders: z.array(AgentOwnedFolderEntrySchema).optional(),
  /** The entry an older Session's `files/` moved to; its `aipg-media://sessions/` URLs resolve there. */
  legacyFilesFolderId: z.string().optional(),
})

export type SessionFile = z.infer<typeof SessionFileSchema>

/** Assistant's default capabilities, for a Reachable Session whose Assistant settings name none. */
export type AssistantCapabilityDefaults = { defaultCapabilities?: string[] }

export type SessionCreateOptions = AssistantCapabilityDefaults & { settingsFrom?: string }

/** One row of the Sessions panel. */
export type SessionSummary = Pick<
  SessionFile,
  | 'id'
  | 'title'
  | 'renamed'
  | 'pinned'
  | 'groupId'
  | 'createdAt'
  | 'updatedAt'
  | 'presetsUsed'
  | 'pickedAgentId'
  | 'reachable'
  | 'includedInOverviews'
  | 'hiddenMessageIds'
> & {
  unreadable?: boolean
  folderList?: SessionFolderList
  /** Only the state travels with every panel row; the text and picture stay on the document. */
  overviewSummaryState?: OverviewSummaryState
}

/** What opening a Session hands the renderer: its row plus the display timeline and summary. */
export type SessionDocument = SessionSummary & {
  timeline: unknown[]
  overviewSummary?: OverviewSummary
}

export const SESSION_NAME_MAX_LENGTH = 500

export const SessionTitleSchema = z.string().trim().min(1).max(SESSION_NAME_MAX_LENGTH)

export const SessionGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.number().int().nonnegative(),
  expanded: z.boolean().default(true),
})

export type SessionGroup = z.infer<typeof SessionGroupSchema>

/** The one Session Groups file beside the Session Folders. */
export const SessionGroupsFileSchema = z.object({
  schemaVersion: z.literal(1),
  groups: z.array(SessionGroupSchema).default([]),
  /** Whether Pinned lists every pinned Session. */
  pinnedShowMore: z.boolean().default(false),
  /** Whether Older lists every Session. */
  olderShowMore: z.boolean().default(false),
})

export type SessionGroupsFile = z.infer<typeof SessionGroupsFileSchema>

/** The panel sections that list a few rows until the user asks for all of them. */
export type ShowMoreSection = 'pinned' | 'older'

export type ShowMore = Record<ShowMoreSection, boolean>

/** What the delete dialog names: the app-created Workspace that moves to the Trash, if any. */
export type SessionDeletePreview = {
  trashedWorkspace: { name: string; fileCount: number } | null
}

export type SessionGroupsState = { groups: SessionGroup[]; showMore: ShowMore }

/** One line of `session-history.jsonl`: a settled turn, never rewritten. */
export const HistoryEntrySchema = z.object({
  id: z.string(),
  timestamp: z.number().int().nonnegative(),
  preset: z.string(),
  variant: z.string().optional(),
  kind: HistoryEntryKindSchema,
  prompt: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  /** `path` is inside folder entry `folderId`; without one (older entries), the Session Folder. */
  artifacts: z.array(
    z.object({
      folderId: z.string().optional(),
      path: z.string(),
      mediaType: ArtifactMediaTypeSchema,
    }),
  ),
  response: z.string().optional(),
  taskName: z.string().optional(),
  /** A Follow-up to a saved Agent, which `preset` (Assistant) ran; older: a chat with it. */
  agentId: z.string().optional(),
  agentName: z.string().optional(),
  followUp: z.boolean().optional(),
  /** The Harness Session the turn ran in; absent on entries from before it was recorded. */
  harnessSessionId: z.string().optional(),
  /** The harness turn that wrote this entry; delete/regenerate removes it with the turn. */
  turnId: z.string().optional(),
  /** What this turn's Overview Summary update did, when its Session is Included in Overviews. */
  overviewUpdate: OverviewSummaryUpdateSchema.optional(),
})

export type HistoryEntry = z.infer<typeof HistoryEntrySchema>
export type HistoryEntryKind = z.infer<typeof HistoryEntryKindSchema>
export type ArtifactMediaType = z.infer<typeof ArtifactMediaTypeSchema>

/** The newest artifact of one media type in a Session, as the History Entry that holds it. */
export type NewestArtifact = { entryId: string; path: string; url: string }

export type HistoryArtifact = HistoryEntry['artifacts'][number]

/** A Session's Harness Session for one agent preset, and the workspace it runs in. */
export type HarnessSessionRef = { harnessSessionId: string; workspaceDir: string }

/**
 * A games preset's Harness Session works in a game folder: none until the first turn
 * mints one (`gameDir`), and `fresh` starts a new Harness Session on a handed-over game.
 */
export const HarnessGameWorkspaceSchema = z.object({
  kind: z.literal('game'),
  gameDir: z.string().min(1).optional(),
  fresh: z.boolean().optional(),
})

export type HarnessGameWorkspace = z.infer<typeof HarnessGameWorkspaceSchema>

/** A settled Text-to-Speech / Speech-to-Text turn the renderer hands the Session module. */
export const AudioTurnRequestSchema = z.object({
  sessionId: z.string(),
  kind: z.enum(['tts', 'stt']),
  preset: z.string(),
  /** TTS: the text spoken; STT: what the source audio is called. */
  prompt: z.string(),
  status: z.enum(['completed', 'failed', 'cancelled']),
  error: z.string().optional(),
  /** STT only. */
  transcript: z.string().optional(),
  engine: z.string().optional(),
  /** TTS: the synthesized clip; STT: the source audio. */
  audio: z.object({ base64: z.string().min(1), fileName: z.string().min(1) }).optional(),
})

export type AudioTurnRequest = z.infer<typeof AudioTurnRequestSchema>
/** One file a History Entry produced, as the gallery lists it. */
export type SessionArtifact = {
  sessionId: string
  sessionTitle: string
  entryId: string
  timestamp: number
  preset: string
  kind: HistoryEntryKind
  prompt: string
  /** Relative to its folder entry, or to the Session Folder for an older Artifact. */
  path: string
  mediaType: ArtifactMediaType
  url: string
}

/** One file a Session's agent turns wrote, as the Artifacts tab lists it. */
export type SessionCreatedFile = {
  /** The path the model addressed the file with. */
  file: string
  /** False once the file is gone from disk, so the transcript chips can strike
   * it out; the Artifacts tab lists only the existing ones. */
  exists: boolean
  /** The Harness Session whose workspace holds the file; previews open against it. */
  harnessSessionId: string
  /** The Session whose timeline wrote the file. */
  sessionRef: string
  sessionTitle: string
  /** When the file was last written; an unstamped write falls back to its
   * Harness Session's creation — static, so a later turn cannot re-float it. */
  createdAt: number
}

export const SessionTurnKindSchema = z.enum(['chat', 'agent', 'media', 'audio'])
export type SessionTurnKind = z.infer<typeof SessionTurnKindSchema>

/** The one turn a Session has in flight; the engine keys say where Stop must go. */
export const SessionTurnSchema = z.object({
  turnId: z.string().min(1),
  kind: SessionTurnKindSchema,
  presetName: z.string().optional(),
  harnessSessionId: z.string().optional(),
  conversationKey: z.string().optional(),
})
export type SessionTurn = z.infer<typeof SessionTurnSchema>

/** Every Session with a turn in flight, by Session id. */
export type SessionTurns = Record<string, SessionTurn>

/** The preset and variant of a Session's last turn, which opening it switches to. */
export type SessionLastPreset = { preset: string; variant?: string }
