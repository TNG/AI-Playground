import { computed, onMounted, reactive } from 'vue'
import { type LlmBackend, useTextInference } from '@/assets/js/store/textInference'
import { useI18N } from '@/assets/js/store/i18n'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useAgentBackendItems } from '@/assets/js/agentBackendItems'
import { useCapabilityCatalog } from '@/assets/js/capabilityCatalog'
import { useEmbeddingModelPicker } from '@/assets/js/embeddingModelPicker'
import type { AgentSettingsBinding } from '@/lib/agentSettingsBinding'
import type { AgentHarness } from '@/lib/agentHarness'
import { developerMode } from '@/assets/js/store/debugSettings'
import { gateCatalogForHarness, hermesContextSize, hermesInstalled } from '@/lib/agentHarness'
import { agentSettingsSections } from '@/lib/agentSettingsSections'
import { storeMediaToolSettings } from '@/lib/mediaToolSettings'
import { catalogModelToolUse, gateCapabilityCatalog } from '@/lib/modelToolUse'
import type { ReasoningEffort } from '@/types/shared'

/** The active Agent Preset's settings as both settings tabs read and write them. */
export function useAgentSettingsPanel() {
  const agentMode = useAgentMode()
  const agentTasks = useAgentTasks()
  const textInference = useTextInference()
  const i18nState = useI18N().state
  const cloudMode = useCloudMode()
  const backendServices = useBackendServices()

  const readOnly = computed(() => agentMode.sessionScoped && agentTasks.openSessionSettingsReadOnly)

  // The catalog is the main process's: it is what the Pi session is actually built from.
  const mediaTools = storeMediaToolSettings(textInference)
  const { catalog: capabilityCatalog, refresh: refreshCapabilityCatalog } = useCapabilityCatalog(
    () => ({
      workspaceDir: agentMode.workspaceDir,
      embeddingModel: textInference.activeEmbeddingModel,
      mediaTools,
    }),
  )
  onMounted(() => void refreshCapabilityCatalog())

  const { activeName: embeddingModelName, items: embeddingModelItems } = useEmbeddingModelPicker(
    () => textInference.llmEmbeddingModels,
    () => textInference.embeddingBackend,
  )

  const { items: backendItems } = useAgentBackendItems(() => agentMode.activeAgentPreset?.backends)

  function setBackend(newBackend: string) {
    textInference.backend = newBackend as LlmBackend
    if (newBackend === 'cloud') cloudMode.refreshSelectedProviderModels()
  }

  const currentModel = computed(() =>
    textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
  )
  const gatedCatalog = computed(() =>
    gateCatalogForHarness(
      gateCapabilityCatalog(
        capabilityCatalog.value,
        catalogModelToolUse(textInference.backend, currentModel.value),
        (reason) => i18nState[reason],
      ),
      agentMode.harness,
      i18nState.AGENT_HARNESS_CAPABILITY_UNSUPPORTED,
    ),
  )

  // Model settings are textInference's, as in Chat; the agent-only ones are agentMode's.
  const binding: AgentSettingsBinding = reactive({
    sections: computed(() => agentSettingsSections(agentMode.activeAgentPreset)),
    backend: computed(() => textInference.backend),
    backendItems,
    setBackend,
    currentModel,
    contextSizeSupported: computed(() => textInference.contextSizeSettingSupported),
    contextSize: computed(() => textInference.contextSize),
    setContextSize: (contextSize: number) => {
      textInference.contextSize = contextSize
      textInference.markContextSizeEdited()
    },
    thinkingToggleSupported: computed(() => textInference.modelSupportsThinkingToggle),
    thinkingEnabled: computed(() => textInference.thinkingEnabled),
    setThinkingEnabled: (enabled: boolean) => {
      textInference.thinkingEnabled = enabled
    },
    planningPhaseSupported: computed(
      () => agentMode.planningPhaseSupported && agentMode.harness !== 'hermes',
    ),
    planningThinkingOnly: computed(() => agentMode.effectivePlanningThinkingOnly),
    setPlanningThinkingOnly: agentMode.setPlanningThinkingOnly,
    maxTokens: computed(() => textInference.maxTokens),
    effectiveMaxTokens: computed(() => textInference.effectiveMaxTokens),
    setMaxTokens: (maxTokens: number) => {
      textInference.maxTokens = maxTokens
    },
    temperature: computed(() => textInference.temperature),
    setTemperature: (temperature: number) => {
      textInference.temperature = temperature
    },
    reasoningEffortSupported: computed(
      () => textInference.modelSupportsReasoningEffort && textInference.thinkingActive,
    ),
    reasoningEffort: computed(() => textInference.effectiveReasoningEffort),
    setReasoningEffort: (effort: string) => {
      textInference.reasoningEffort = effort as ReasoningEffort
    },
    mtpSupported: computed(() => textInference.modelSupportsMtp),
    mtpDraftTokens: computed(() => textInference.numAssistantTokens),
    setMtpDraftTokens: (tokens: number) => {
      textInference.numAssistantTokens = tokens
    },
    metricsEnabled: computed(() => textInference.metricsEnabled),
    setMetricsEnabled: (enabled: boolean) => {
      textInference.metricsEnabled = enabled
    },
    systemPrompt: computed(() => textInference.systemPrompt),
    presetSystemPrompt: computed(() => agentMode.activeAgentPreset?.systemPrompt ?? ''),
    setSystemPrompt: (prompt: string) => {
      textInference.systemPrompt = prompt
    },
    harnessSupported: computed(
      () =>
        agentMode.sessionScoped &&
        ((developerMode() && hermesInstalled(backendServices.info)) ||
          agentMode.harness === 'hermes'),
    ),
    harness: computed(() => agentMode.harness),
    harnessLocked: computed(() => agentMode.harnessLocked),
    setHarness: (next: AgentHarness) => {
      agentMode.setHarness(next)
      if (agentMode.harness !== 'hermes' || textInference.backend !== 'llamaCPP') return
      const raised = hermesContextSize(
        textInference.contextSize,
        textInference.maxContextSizeFromModel,
      )
      if (raised === textInference.contextSize) return
      textInference.contextSize = raised
      textInference.markContextSizeEdited()
    },
    capabilities: computed(() => agentMode.capabilities),
    setCapabilities: agentMode.setCapabilities,
    capabilityCatalog: gatedCatalog,
    embeddingModelName,
    embeddingModelItems,
    setEmbeddingModel: (modelName: string) =>
      textInference.selectEmbeddingModel(textInference.embeddingBackend, modelName),
    mediaTools,
    problems: computed(() => agentMode.settingsProblems),
    sharedWithChat: computed(() => !agentMode.sessionScoped),
  })

  /** The Session's copy of the preset was reset: drop the agent-only overrides too. */
  function onPresetReset() {
    agentMode.resetPresetSettings()
    void refreshCapabilityCatalog()
  }

  return { binding, capabilityCatalog, refreshCapabilityCatalog, onPresetReset, readOnly }
}
