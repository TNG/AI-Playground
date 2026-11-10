import { computed, onMounted, reactive } from 'vue'
import { type LlmBackend, useTextInference } from '@/assets/js/store/textInference'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { HARNESS_CHAT_PRESET, isHarnessChatPreset } from '@/lib/harnessChatPreset'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { useAgentBackendItems } from '@/assets/js/agentBackendItems'
import { useCapabilityCatalog } from '@/assets/js/capabilityCatalog'
import { useEmbeddingModelPicker } from '@/assets/js/embeddingModelPicker'
import type { AgentSettingsBinding } from '@/lib/agentSettingsBinding'
import { agentSettingsSections } from '@/lib/agentSettingsSections'
import { sessionSettingsToBag } from '@/lib/agentSessionSettings'
import { normalizeNumAssistantTokens } from '@/lib/ovmsMtp'
import { contextSizeSettingSupported, isNpuDevice } from '@/lib/llmBackendChoices'
import { templateMediaToolSettings } from '@/lib/mediaToolSettings'
import { catalogModelToolUse, gateCapabilityCatalog } from '@/lib/modelToolUse'
import type { SessionSettingsProblem } from '@/lib/sessionSettingsProblems'
import { PLANNING_PHASE_CAPABILITY_IDS } from '@/types/agentCapabilities'
import type { AgentSessionSettings, MountedFolder } from '@/types/agentSessionIpc'

export type TemplateSettingsSource = {
  template: () => AgentSessionSettings
  problems: () => readonly SessionSettingsProblem[]
  /** Absent for a template shown read-only. */
  edit?: (change: AgentSessionSettings) => void
}

/**
 * An Agent's Settings Template as both agent settings tabs read and write it. Fields the
 * template leaves out show what a run would use: the Agent preset's Default Settings.
 */
export function useTemplateSettingsBinding(source: TemplateSettingsSource) {
  const textInference = useTextInference()
  const agentMode = useAgentMode()
  const presets = usePresets()

  const edit = (change: AgentSessionSettings) => source.edit?.(change)
  const template = computed(() => source.template())
  const resolved = computed(() =>
    textInference.inferenceForSettings(HARNESS_CHAT_PRESET, template.value),
  )
  const backend = computed(() => resolved.value.inference.backend as LlmBackend)
  const defaults = computed(() => agentMode.agentDefaults())
  const capabilities = computed(() => template.value.capabilities ?? defaults.value.capabilities)

  const mediaTools = templateMediaToolSettings(
    () => ({ ...resolved.value.tools, ...template.value }),
    edit,
  )
  const { catalog: capabilityCatalog, refresh: refreshCapabilityCatalog } = useCapabilityCatalog(
    () => ({
      workspaceDir: '',
      embeddingModel: resolved.value.inference.activeEmbeddingModel,
      mediaTools,
    }),
  )
  onMounted(() => void refreshCapabilityCatalog())

  const { activeName: embeddingModelName, items: embeddingModelItems } = useEmbeddingModelPicker(
    () => textInference.llmEmbeddingModels,
    () => resolved.value.inference.embeddingBackend,
    () => resolved.value.inference.activeEmbeddingModel ?? undefined,
  )

  const agentPreset = computed(() =>
    presets.presets.find(
      (preset): preset is ChatPreset => preset.type === 'chat' && isHarnessChatPreset(preset.name),
    ),
  )
  const { items: backendItems } = useAgentBackendItems(() => agentPreset.value?.backends)

  // The template laid over the Default Settings, for the values no inference input carries.
  const bag = computed(() =>
    sessionSettingsToBag(
      template.value,
      textInference.settingsPerPreset?.[HARNESS_CHAT_PRESET] ?? {},
    ),
  )
  const currentModel = computed(() =>
    textInference.llmModels.find(
      (m) => m.type === backend.value && m.name === resolved.value.inference.activeModel,
    ),
  )

  const binding: AgentSettingsBinding = reactive({
    sections: computed(() => agentSettingsSections(agentPreset.value)),
    backend,
    backendItems,
    // The model picked for the old backend is not offered on the new one.
    setBackend: (next: string) => edit({ backend: next as LlmBackend, model: undefined }),
    currentModel,
    contextSizeSupported: computed(() =>
      contextSizeSettingSupported(
        backend.value,
        isNpuDevice(resolved.value.inference.getCurrentDeviceId() ?? undefined),
      ),
    ),
    contextSize: computed(() => resolved.value.inference.contextSize ?? 0),
    setContextSize: (contextSize: number) => edit({ contextSize, contextSizeEdited: true }),
    thinkingToggleSupported: computed(() => resolved.value.inference.modelSupportsThinkingToggle),
    thinkingEnabled: computed(() => resolved.value.inference.thinkingEnabled),
    setThinkingEnabled: (thinkingEnabled: boolean) => edit({ thinkingEnabled }),
    planningPhaseSupported: computed(() =>
      capabilities.value.some((id) => PLANNING_PHASE_CAPABILITY_IDS.includes(id)),
    ),
    planningThinkingOnly: computed(
      () => template.value.planningThinkingOnly ?? defaults.value.planningThinkingOnly,
    ),
    setPlanningThinkingOnly: (planningThinkingOnly: boolean) => edit({ planningThinkingOnly }),
    maxTokens: computed(() => resolved.value.inference.maxTokens ?? 0),
    effectiveMaxTokens: computed(() => resolved.value.inference.effectiveMaxTokens ?? 0),
    setMaxTokens: (maxTokens: number) => edit({ maxTokens }),
    temperature: computed(() => resolved.value.inference.temperature),
    setTemperature: (temperature: number) => edit({ temperature, temperatureFromModel: undefined }),
    reasoningEffortSupported: computed(
      () =>
        resolved.value.inference.effectiveReasoningEffort !== undefined &&
        resolved.value.inference.thinkingActive,
    ),
    reasoningEffort: computed(() => resolved.value.inference.effectiveReasoningEffort),
    setReasoningEffort: (reasoningEffort: string) =>
      edit({ reasoningEffort, reasoningEffortFromModel: undefined }),
    mtpSupported: computed(
      () =>
        backend.value === 'openVINO' &&
        !isNpuDevice(resolved.value.inference.getCurrentDeviceId() ?? undefined) &&
        currentModel.value?.enableMtp === true,
    ),
    mtpDraftTokens: computed(() => normalizeNumAssistantTokens(bag.value.numAssistantTokens)),
    setMtpDraftTokens: (numAssistantTokens: number) => edit({ numAssistantTokens }),
    metricsEnabled: computed(() => bag.value.metricsEnabled === true),
    setMetricsEnabled: (metricsEnabled: boolean) => edit({ metricsEnabled }),
    systemPrompt: computed(
      () => resolved.value.systemPrompt ?? agentPreset.value?.systemPrompt ?? '',
    ),
    presetSystemPrompt: computed(() => agentPreset.value?.systemPrompt ?? ''),
    setSystemPrompt: (systemPrompt: string) => edit({ systemPrompt }),
    capabilities,
    setCapabilities: (next: string[]) => edit({ capabilities: next }),
    capabilityCatalog: computed(() =>
      gateCapabilityCatalog(
        capabilityCatalog.value,
        catalogModelToolUse(backend.value, resolved.value.inference.activeLlmModel),
      ),
    ),
    mountedFoldersSupported: true,
    mountedFolders: computed(
      () => template.value.mountedFolders ?? defaults.value.mountedFolders ?? [],
    ),
    setMountedFolders: (mountedFolders: MountedFolder[]) => edit({ mountedFolders }),
    embeddingModelName,
    embeddingModelItems,
    setEmbeddingModel: (embeddingModel: string) => edit({ embeddingModel }),
    mediaTools,
    problems: computed(() => source.problems()),
    sharedWithChat: false,
    template: {
      model: computed(() => resolved.value.inference.activeModel ?? ''),
      setModel: (model: string) => edit({ model }),
      cloudProviderId: computed(() => resolved.value.cloud.selectedProviderId),
      setCloudProviderId: (cloudProviderId: string) => edit({ cloudProviderId }),
    },
  })

  return { binding, capabilityCatalog, refreshCapabilityCatalog }
}
