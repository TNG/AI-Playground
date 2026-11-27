import type { llmBackendTypes } from '@/types/shared'

type LlmBackend = (typeof llmBackendTypes)[number]

export type SavedChatSettings = {
  backend?: LlmBackend
  model?: string
}

export type ChatSettingsAvailability = {
  presetBackends: readonly LlmBackend[]
  presetPreferredModels?: Partial<Record<LlmBackend, string>>
  cloudEnabled: boolean
  runningBackends: readonly LlmBackend[]
  models: readonly { name: string; type: string; npuSupport?: boolean }[]
  /** The OpenVINO device is an NPU, which runs only the models marked for it. */
  onNpu?: boolean
}

export type RepairedChatSettings = {
  backend: LlmBackend | undefined
  /** Model to select; undefined leaves the choice to the model picker. */
  model: string | undefined
}

/** The silent repair a preset load applies to saved backend and model choices. */
export function repairChatSettings(
  saved: SavedChatSettings,
  available: ChatSettingsAvailability,
): RepairedChatSettings {
  const backend = repairBackend(saved.backend, available)
  return {
    backend,
    model: backend ? repairModel(saved.model, backend, available) : undefined,
  }
}

function repairBackend(
  saved: LlmBackend | undefined,
  available: ChatSettingsAvailability,
): LlmBackend | undefined {
  // Cloud is feature-flagged and offered for any chat preset, so presets rarely list it.
  const cloudAllowed = saved === 'cloud' && available.cloudEnabled
  if (saved !== undefined && (available.presetBackends.includes(saved) || cloudAllowed)) {
    return saved
  }
  const backends = available.presetBackends
  if (backends.length === 0) return undefined
  if (backends.length === 1) return backends[0]
  return backends.find((b) => available.runningBackends.includes(b)) ?? backends[0]
}

function repairModel(
  saved: string | undefined,
  backend: LlmBackend,
  available: ChatSettingsAvailability,
): string | undefined {
  const exists = (name: string) =>
    available.models.some((m) => m.name === name && m.type === backend)
  if (saved !== undefined) return exists(saved) ? saved : undefined
  const preferred = available.presetPreferredModels?.[backend]
  if (backend === 'openVINO' && available.onNpu) {
    const npuModels = available.models.filter((m) => m.type === backend && m.npuSupport === true)
    return (npuModels.find((m) => m.name === preferred) ?? npuModels[0])?.name
  }
  return preferred && exists(preferred) ? preferred : undefined
}
