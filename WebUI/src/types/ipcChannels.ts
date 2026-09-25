import type {
  AgentCapabilityInfo,
  AgentModeTurnConfig,
  AgentToolExecuteRequest,
  AgentToolSpec,
} from './agentIpc'
import type { AgentSessionBootstrap, AgentSessionRecordWire } from './agentSessionIpc'
import type { AgentWorkspaceState } from './agentWorkspaceIpc'
import type { ArtifactRunRequest, ArtifactRunResult } from './artifactIpc'
import type { ChatSummarizeRequest, ChatTurnRequest, ChatTurnResumeResult } from './chatIpc'
import type { ChatAnswerPayload, ChatAskPayload } from './chatRequests'
import type { ConversationBootstrap, ConversationSaveRequest } from './conversationIpc'
import type { MediaItemsBootstrap } from './mediaItemIpc'
import type { MediaRequestPayload, MediaResponsePayload } from './mediaRequests'
import type {
  PermissionGrant,
  PermissionGrantOrigin,
  PermissionsPromptPayload,
  PermissionsPromptResponse,
} from './permissionsIpc'
import type { RagDocumentSection } from './ragDocumentIpc'

export type IpcOwner = 'main' | 'homeAgent'
export type IpcKind = 'invoke' | 'send' | 'push'

export type InvokeRow<A extends readonly unknown[] = readonly unknown[], R = unknown> = {
  kind: 'invoke'
  owner: IpcOwner
  args: A
  result: R
  /** Optional bridge member-name override when the naming convention does not fit. */
  member?: string
}

export type SendRow<A extends readonly unknown[] = readonly unknown[]> = {
  kind: 'send'
  owner: IpcOwner
  args: A
  member?: string
}

export type PushRow<P = unknown> = {
  kind: 'push'
  owner: IpcOwner
  payload: P
  /** `true` for the five raw `ipcRenderer.on` listeners that return void instead of an unsubscribe. */
  raw?: boolean
  member?: string
}

/** An M→R ask is two rows — a push for the question, an invoke for the answer (`chat:ask`/`chat:answer`). */
export type IpcRow = InvokeRow | SendRow | PushRow

export type IpcOk = { success: true }
export type IpcFail = { success: false; error: string }
export type IpcMutationResult = IpcOk | IpcFail
export type IpcDataResult<T> = { success: true; data: T } | IpcFail
export type IpcStatusError = { status: 'error'; error: string }

export const CHANNELS = {
  /** Hydrate the conversation store once before mount: thread files, metadata, last main key. */
  'conversations:bootstrap': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as ConversationBootstrap | IpcStatusError,
  },
  /** One-shot upload of the legacy localStorage Pinia state; same result shape as bootstrap. */
  'conversations:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as ConversationBootstrap | IpcStatusError,
  },
  /** Upsert one thread file (user mutations; the turn engine has its own writer). */
  'conversations:save': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ConversationSaveRequest],
    result: null as unknown as IpcMutationResult,
  },
  /** Delete one thread file by conversation id. */
  'conversations:delete': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as IpcMutationResult,
  },
  /** Persist the last-used main-thread key. */
  'conversations:saveLastMainKey': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string | null],
    result: null as unknown as IpcMutationResult,
  },
  /** Hydrate the media-gallery records once before mount: item files plus the ordered index. */
  'mediaItems:bootstrap': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as MediaItemsBootstrap | IpcStatusError,
  },
  /** One-shot legacy upload of the localStorage gallery; same result shape as bootstrap. */
  'mediaItems:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown[]],
    result: null as unknown as MediaItemsBootstrap | IpcStatusError,
  },
  /** Upsert gallery record files plus their index entries (user mutations only). */
  'mediaItems:save': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown[]],
    result: null as unknown as IpcMutationResult,
  },
  /** Delete gallery record files and their index entries by id. */
  'mediaItems:delete': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string[]],
    result: null as unknown as IpcMutationResult,
  },
  /** All preference sections at once; the file is small, so every store picks its own. */
  'preferences:read': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: true; sections: Record<string, unknown> } | IpcFail,
  },
  /** One-shot legacy upload of one section; writes only when the section is absent. */
  'preferences:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Replace one store's section in the kernel-owned preferences file. */
  'preferences:write': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** The indexed RAG document list; `section: null` means never-migrated, not failed. */
  'ragDocuments:read': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: true; section: RagDocumentSection | null } | IpcFail,
  },
  /** One-shot legacy upload of the document list; writes only when the file is absent. */
  'ragDocuments:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Replace the whole indexed document list. */
  'ragDocuments:write': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Run one agent turn on the Pi harness; the stream crosses the kernel bus. */
  'agentMode:startTurn': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string, AgentModeTurnConfig],
    result: null as unknown as { success: boolean; error?: string },
  },
  /** Abort the running agent turn, if any. */
  'agentMode:cancel': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as void,
  },
  /** Hard-reset the live Pi session and its workspace runtime. */
  'agentMode:resetSession': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as void,
  },
  /** Delete one session's record file and main-side Pi state. */
  'agentMode:deleteSession': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as IpcMutationResult,
  },
  /** Hydrate the session-panel records once before mount: session files plus the active id. */
  'agentMode:bootstrapSessions': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as AgentSessionBootstrap | IpcStatusError,
  },
  /** One-shot upload of the legacy persisted sessions; same result shape as bootstrap. */
  'agentMode:migrateSessions': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as AgentSessionBootstrap | IpcStatusError,
  },
  /** Upsert one session record file plus its index entry. */
  'agentMode:saveSession': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [AgentSessionRecordWire],
    result: null as unknown as IpcMutationResult,
  },
  /** Persist the active session id (null clears it). */
  'agentMode:saveActiveSessionId': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string | null],
    result: null as unknown as IpcMutationResult,
  },
  /** The last-used workspace pointers; `section: null` means never-migrated, not failed. */
  'agentMode:readWorkspaceState': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: true; section: AgentWorkspaceState | null } | IpcFail,
  },
  /** One-shot legacy upload of the workspace pointers; writes only when absent. */
  'agentMode:migrateWorkspaceState': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Replace the whole workspace-pointer section. */
  'agentMode:writeWorkspaceState': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown],
    result: null as unknown as IpcMutationResult,
  },
  /** Copy an attached file into the workspace; the answer carries its relative path. */
  'agentMode:importAttachment': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string, Uint8Array],
    result: null as unknown as { success: true; path: string } | IpcFail,
  },
  /** What the agent could be equipped with, for the Capabilities checkboxes. */
  'agentMode:listCapabilities': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [
      { workspaceDir?: string; toolSpecs?: AgentToolSpec[]; mcpServerIds?: string[] },
    ],
    result: null as unknown as AgentCapabilityInfo[],
  },
  /** Main hands a renderer-implemented tool call to the window to run. */
  'agentMode:executeTool': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as AgentToolExecuteRequest,
  },
  /** The renderer's answer to an executeTool dispatch, keyed by requestId. */
  'agentMode:toolResult': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, unknown, string?],
    result: null as unknown as void,
    // `as const` keeps the override a literal: the row type's `member?: string`
    // context would widen it to string, collapsing the bridge's key remap.
    member: 'submitToolResult' as const,
  },

  // ── Chat turns (step 6): the engine runs in main, the stream is kernel events ──

  /** Submit one resolved chat turn; the engine streams chunks on the kernel bus. */
  'chat:submitTurn': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ChatTurnRequest],
    result: null as unknown as { success: true; turnId: string } | IpcFail,
  },
  /** Rehydrate a (re)connecting renderer's live turn from the bus snapshot. */
  'chat:resumeTurn': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as ChatTurnResumeResult,
  },
  /** Abort the running turn for a conversation, if any. */
  'chat:cancelTurn': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, string],
    result: null as unknown as { success: true },
  },
  /** One-shot conversation-title summarization; occupies as `text`, `remember: false`. */
  'chat:summarize': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ChatSummarizeRequest],
    result: null as unknown as IpcDataResult<string>,
  },
  /** The renderer's answer to a `chat:ask` question, keyed by requestId. */
  'chat:answer': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ChatAnswerPayload],
    result: null as unknown as void,
  },
  /** Main asks the window for the one answer a chat tool needs (speech seam, confirm cards). */
  'chat:ask': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as ChatAskPayload,
  },

  // ── Artifact pipeline (step 5): resolved runs in, settled results out ──

  /** Submit one resolved artifact run; the runner owns readiness and settlement. */
  'artifact:run': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [ArtifactRunRequest, { queue?: 'fail-fast' | 'queue' }?],
    result: null as unknown as ArtifactRunResult,
  },
  /** Cancel the active run, or one in-flight run by id. */
  'artifact:cancel': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string?],
    result: null as unknown as void,
  },
  /** The renderer's answer to an `artifact:request`, keyed by requestId. */
  'artifact:respond': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [MediaResponsePayload],
    result: null as unknown as void,
  },
  /** Main asks the renderer for the model pre-flight and download consent. */
  'artifact:request': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as MediaRequestPayload,
  },

  // ── Permissions (step 13): policy in main, dialogs in the renderer ──

  /** Desktop download modal / Home Agent in-channel consent for model downloads. */
  'permissions:requestDownload': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [unknown[]],
    result: null as unknown as
      { success: true } | { success: false; error: string; cancelled?: boolean },
  },
  /** The high-memory / video-VRAM gate; a confirmed "do not show again" records a grant. */
  'permissions:requestVramWarning': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [{ presetName: string; message: string }],
    result: null as unknown as { success: true; confirmed: boolean } | IpcFail,
  },
  /** Every recorded consent grant (Settings → Permissions). */
  'permissions:list': {
    kind: 'invoke',
    owner: 'main',
    args: [] as const,
    result: null as unknown as { success: true; grants: PermissionGrant[] } | IpcFail,
  },
  /** Record a grant (a remember tick or a Settings pre-grant). */
  'permissions:grant': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string, PermissionGrantOrigin],
    result: null as unknown as { success: true; grant: PermissionGrant } | IpcFail,
  },
  /** Remove one grant by key. */
  'permissions:revoke': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [string],
    result: null as unknown as IpcMutationResult,
  },
  /** One-shot upload of the legacy persisted grants. */
  'permissions:migrate': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [Record<string, PermissionGrant>],
    result: null as unknown as IpcMutationResult,
  },
  /** The renderer's answer to a `permissions:prompt`, keyed by requestId. */
  'permissions:respond': {
    kind: 'invoke',
    owner: 'main',
    args: [] as unknown as readonly [PermissionsPromptResponse],
    result: null as unknown as void,
  },
  /** Main asks the window to show a consent dialog (download modal, VRAM warning). */
  'permissions:prompt': {
    kind: 'push',
    owner: 'main',
    payload: null as unknown as PermissionsPromptPayload,
  },
} satisfies Record<string, IpcRow>

export type ChannelManifest = typeof CHANNELS
export type ChannelName = keyof ChannelManifest

export type InvokeChannelName = {
  [K in ChannelName]: ChannelManifest[K]['kind'] extends 'invoke' ? K : never
}[ChannelName]
export type SendChannelName = {
  [K in ChannelName]: ChannelManifest[K]['kind'] extends 'send' ? K : never
}[ChannelName]
export type PushChannelName = {
  [K in ChannelName]: ChannelManifest[K]['kind'] extends 'push' ? K : never
}[ChannelName]

export type ChannelArgs<N extends ChannelName> = ChannelManifest[N] extends {
  args: infer A extends readonly unknown[]
}
  ? A
  : never
export type ChannelResult<N extends ChannelName> = ChannelManifest[N] extends { result: infer R }
  ? R
  : never
export type PushPayload<N extends ChannelName> = ChannelManifest[N] extends { payload: infer P }
  ? P
  : never

export type BridgeMemberFor<N extends ChannelName> =
  ChannelManifest[N] extends InvokeRow<infer A, infer R>
    ? (...args: A) => Promise<R>
    : ChannelManifest[N] extends SendRow<infer A>
      ? (...args: A) => void
      : ChannelManifest[N] extends PushRow<infer P> & { raw: true }
        ? (callback: (payload: P) => void) => void
        : ChannelManifest[N] extends PushRow<infer P>
          ? (callback: (payload: P) => void) => () => void
          : never

type ChannelLeaf<S extends string> = S extends `${string}:${infer Leaf}` ? ChannelLeaf<Leaf> : S

type BridgeLeafName<N extends ChannelName> = ChannelManifest[N] extends {
  member: infer M extends string
}
  ? M
  : ChannelManifest[N] extends PushRow
    ? `on${Capitalize<ChannelLeaf<N>>}`
    : ChannelLeaf<N>

export type NamespaceBridge<NS extends string> = {
  [K in ChannelName as K extends `${NS}:${string}` ? BridgeLeafName<K> : never]: BridgeMemberFor<K>
}

type ChannelNamespace<S extends string> = S extends `${infer NS}:${string}` ? NS : never

type AllNamespaces = keyof {
  [K in ChannelName as K extends `${string}:${string}` ? ChannelNamespace<K> : never]: never
}

type ChannelGroupLeaves<NS extends string> = {
  [
    K in ChannelName as K extends `${NS}:${infer Rest}`
      ? Rest extends `${string}:${string}`
        ? never
        : BridgeLeafName<K>
      : never
  ]: BridgeMemberFor<K>
}

type SubNamespaces<NS extends string> = keyof {
  [K in ChannelName as K extends `${NS}:${infer Sub}:${string}` ? Sub : never]: never
}

type ChannelGroup<NS extends string> = ChannelGroupLeaves<NS> & {
  [Sub in SubNamespaces<NS>]: ChannelGroup<`${NS}:${Sub}`>
}

/** Bridge members that are not IPC channels (webUtils utilities) — the manifest's escape hatch. */
export type IpcExtraBridgeMembers = {
  getFilePath: (file: File) => string
}

export type ElectronApi = {
  [
    K in ChannelName as K extends `${string}:${string}` ? never : BridgeLeafName<K>
  ]: BridgeMemberFor<K>
} & {
  [NS in AllNamespaces]: ChannelGroup<NS>
} & IpcExtraBridgeMembers
