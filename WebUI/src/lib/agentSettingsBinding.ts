import type { LlmBackend, LlmModel } from '@/assets/js/store/textInference'
import type { AgentSettingsSections } from '@/lib/agentSettingsSections'
import type { MediaToolSettings } from '@/lib/mediaToolSettings'
import type { SessionSettingsProblem } from '@/lib/sessionSettingsProblems'
import type { MountedFolder } from '@/types/agentSessionIpc'

export type AgentSettingsChoice = { label: string; value: string; active: boolean }

/** What the Agent Preset settings tabs read and write. */
export type AgentSettingsBinding = {
  sections: AgentSettingsSections
  backend: LlmBackend
  backendItems: AgentSettingsChoice[]
  setBackend: (backend: string) => void
  currentModel: LlmModel | undefined
  contextSizeSupported: boolean
  contextSize: number
  setContextSize: (contextSize: number) => void
  thinkingToggleSupported: boolean
  thinkingEnabled: boolean
  setThinkingEnabled: (enabled: boolean) => void
  /** Only a session with a capability that ends a planning phase can drop thinking after it. */
  planningPhaseSupported: boolean
  planningThinkingOnly: boolean
  setPlanningThinkingOnly: (enabled: boolean) => void
  maxTokens: number
  /** `maxTokens` bounded by the window, when that is less. */
  effectiveMaxTokens: number
  setMaxTokens: (maxTokens: number) => void
  temperature: number
  setTemperature: (temperature: number) => void
  /** The model reads a reasoning effort, and thinks this turn. */
  reasoningEffortSupported: boolean
  reasoningEffort: string | undefined
  setReasoningEffort: (effort: string) => void
  mtpSupported: boolean
  mtpDraftTokens: number
  setMtpDraftTokens: (tokens: number) => void
  metricsEnabled: boolean
  setMetricsEnabled: (enabled: boolean) => void
  /** The user's own prompt; empty means `presetSystemPrompt`. */
  systemPrompt: string
  presetSystemPrompt: string
  setSystemPrompt: (prompt: string) => void
  capabilities: string[]
  setCapabilities: (ids: string[]) => void
  capabilityCatalog: AgentCapabilityInfo[]
  mountedFoldersSupported: boolean
  mountedFolders: MountedFolder[]
  setMountedFolders: (folders: MountedFolder[]) => void
  embeddingModelName: string
  embeddingModelItems: AgentSettingsChoice[]
  setEmbeddingModel: (modelName: string) => void
  mediaTools: MediaToolSettings
  problems: readonly SessionSettingsProblem[]
  /** Game Agent and Quick Coder keep their model settings in Chat's, so a change there shows here. */
  sharedWithChat: boolean
  /** Set when bound to an Agent's Settings Template: the model pickers write here, not to Chat. */
  template?: AgentTemplateChoices
}

/** The model and provider picks of a Settings Template, which the live controls keep in Chat. */
export type AgentTemplateChoices = {
  model: string
  setModel: (model: string) => void
  cloudProviderId: string
  setCloudProviderId: (providerId: string) => void
}
