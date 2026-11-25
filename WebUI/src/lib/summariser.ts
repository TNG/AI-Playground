import type { ChatModelConfig } from '@/types/chatIpc'
import type { Summariser } from '@/types/sessionIpc'

/** Summaries are local work: a cloud setup, or a local backend with no model, cannot write one. */
export function isLocalSummaryModel(model: ChatModelConfig | undefined): model is ChatModelConfig {
  return !!model && model.backend !== 'cloud' && !!model.readiness?.llmModelName
}

export function localSummaryModel(summariser: Summariser | undefined): ChatModelConfig | null {
  return isLocalSummaryModel(summariser?.model) ? summariser.model : null
}

export function summariserModelName(model: ChatModelConfig): string {
  return model.readiness?.llmModelName ?? model.modelId
}

/**
 * The same model with reasoning turned off: a summary is a short extraction, not a
 * problem to think through, and a reasoning trace is what made one take minutes.
 */
export function summaryModelConfig(model: ChatModelConfig): ChatModelConfig {
  const { reasoning_effort: _reasoning, ...rest } = model.chatTemplateKwargs ?? {}
  return {
    ...model,
    // Always explicit: a template that defaults to thinking must be told not to.
    chatTemplateKwargs: { ...rest, enable_thinking: false },
  }
}
