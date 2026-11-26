import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import {
  enabledCapabilityIds,
  FILES_CAPABILITY_ID,
  HERMES_UNSUPPORTED_CAPABILITY_IDS,
} from '@/types/agentCapabilities'

export type AgentHarness = 'pi' | 'hermes'

/** Hermes refuses an agent session below this window. */
export const HERMES_MIN_CONTEXT = 64_000

/** A Session's own choice wins over its preset's; neither set means Pi. */
export function sessionHarness(
  settings: Pick<AgentSessionSettings, 'harness'> | null | undefined,
  preset?: { harness?: AgentHarness } | null,
): AgentHarness {
  return settings?.harness ?? preset?.harness ?? 'pi'
}

export function hermesInstalled(
  services: readonly { serviceName: string; isSetUp: boolean }[],
): boolean {
  return services.some((service) => service.serviceName === 'hermes-backend' && service.isSetUp)
}

export function hermesSupportsCapability(id: string): boolean {
  return !HERMES_UNSUPPORTED_CAPABILITY_IDS.includes(id)
}

/** Marks what a Hermes turn would leave out, the way a model gate marks what it cannot run. */
export function gateCatalogForHarness<T extends { id: string; unavailableReason?: string }>(
  catalog: readonly T[],
  harness: AgentHarness,
  reason: string,
): T[] {
  if (harness !== 'hermes') return [...catalog]
  return catalog.map((capability) =>
    capability.unavailableReason || hermesSupportsCapability(capability.id)
      ? capability
      : { ...capability, unavailableReason: reason },
  )
}

/** Hermes gets its file and terminal toolsets exactly when Pi would keep its file and shell tools. */
export function hermesFileTools(config: {
  ownsPrompt?: boolean
  capabilities?: string[]
  mcpServerIds?: string[]
}): boolean {
  return config.ownsPrompt !== true || enabledCapabilityIds(config).includes(FILES_CAPABILITY_ID)
}
