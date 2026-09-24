import type { ConversationBootstrap, ConversationSaveRequest } from './conversationIpc'

export type IpcOwner = 'main' | 'homeAgent'
export type IpcKind = 'invoke' | 'send' | 'push' | 'ask'

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

/** An M→R request paired with an R→M answer channel (e.g. chat:ask / chat:answer). */
export type AskRow<P = unknown, A = unknown> = {
  kind: 'ask'
  owner: IpcOwner
  payload: P
  /** The R→M answer channel's argument type. */
  answer: A
  member?: string
}

export type IpcRow = InvokeRow | SendRow | PushRow | AskRow

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
export type AskChannelName = {
  [K in ChannelName]: ChannelManifest[K]['kind'] extends 'ask' ? K : never
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
          : ChannelManifest[N] extends AskRow<infer P, infer A>
            ? {
                listen: (callback: (payload: P) => void) => () => void
                answer: (payload: A) => void
              }
            : never

type ChannelLeaf<S extends string> = S extends `${string}:${infer Leaf}` ? ChannelLeaf<Leaf> : S

type BridgeLeafName<N extends ChannelName> = ChannelManifest[N] extends {
  member: infer M extends string
}
  ? M
  : ChannelManifest[N] extends PushRow | AskRow
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
