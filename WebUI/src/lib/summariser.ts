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
