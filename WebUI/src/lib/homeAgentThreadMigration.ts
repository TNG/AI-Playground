import { createAppError } from '@/assets/js/errors/appError'
import type { AppError } from '@/assets/js/errors/types'
import { ChannelKindSchema, type ChannelKind } from '@/assets/js/store/channels/types'

// Main moves Home Agent threads into Sessions; only the window kept which thread Channels were on.

export const LEGACY_HOME_AGENT_STORAGE_KEY = 'homeAgent'

export type HomeAgentThreadMigrationDeps = {
  /** The Home Agent store's persisted Pinia state, read raw so it outlives that store. */
  storedHomeAgentState: () => string | null
  defaultCapabilities: () => string[]
  migrate: (input: {
    routingKey: string | null
    defaultCapabilities: string[]
  }) => Promise<
    { success: true; channelSession: string | null } | { success: false; error: string }
  >
  setChannelSession: (kind: ChannelKind, sessionRef: string) => void
  report: (error: AppError) => void
}

export function legacyRoutingKey(raw: string | null): string | null {
  if (!raw) return null
  try {
    const key = (JSON.parse(raw) as { activeRemoteConversationKey?: unknown } | null)
      ?.activeRemoteConversationKey
    return typeof key === 'string' && key ? key : null
  } catch {
    return null
  }
}

export async function migrateHomeAgentThreads(deps: HomeAgentThreadMigrationDeps): Promise<void> {
  const result = await deps
    .migrate({
      routingKey: legacyRoutingKey(deps.storedHomeAgentState()),
      defaultCapabilities: deps.defaultCapabilities(),
    })
    .catch((error: unknown) => ({ success: false as const, error: String(error) }))
  if (!result.success) {
    deps.report(
      createAppError({
        category: 'channel',
        code: 'channel/home-agent-thread-migration-failed',
        userMessage: 'Home Agent threads could not be moved into Sessions',
        technicalMessage: result.error,
        surface: 'silent',
      }),
    )
    return
  }
  const sessionRef = result.channelSession
  if (!sessionRef) return
  for (const kind of ChannelKindSchema.options) deps.setChannelSession(kind, sessionRef)
}
