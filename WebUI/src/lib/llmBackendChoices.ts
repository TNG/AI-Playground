import type { LlmBackend } from '@/assets/js/store/textInference'

export type AgentBackendChoiceContext = {
  presetBackends: readonly LlmBackend[] | undefined
  productMode: ProductMode | null
  cloudEnabled: boolean
}

/** The backends an Agent settings form offers: the preset's local ones, then cloud if enabled. */
export function agentBackendChoices({
  presetBackends,
  productMode,
  cloudEnabled,
}: AgentBackendChoiceContext): LlmBackend[] {
  let choices = presetBackends?.filter((b) => b !== 'cloud') ?? ['llamaCPP', 'openVINO']
  if (productMode === 'nvidia') choices = choices.filter((b) => b !== 'openVINO')
  return cloudEnabled ? [...choices, 'cloud'] : choices
}

/** OpenVINO on GPU sizes its KV cache at runtime, so only llama.cpp and an NPU take a context size. */
export function contextSizeSettingSupported(backend: LlmBackend, onNpu: boolean): boolean {
  return backend === 'llamaCPP' || (backend === 'openVINO' && onNpu)
}

export const isNpuDevice = (deviceId: string | undefined): boolean => !!deviceId?.includes('NPU')
