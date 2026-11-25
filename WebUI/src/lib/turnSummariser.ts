import { useI18N } from '@/assets/js/store/i18n'
import { useSessions } from '@/assets/js/store/sessions'
import { backendToService, useTextInference } from '@/assets/js/store/textInference'
import { HARNESS_CHAT_PRESET } from '@/lib/harnessChatPreset'
import { chatTemplateKwargs } from '@/lib/samplingDefaults'
import type { ReasoningEffort } from '@/types/shared'
import type { ChatModelConfig } from '@/types/chatIpc'
import type { Summariser } from '@/types/sessionIpc'

/**
 * The Assistant preset's local model, which an activation, refresh or a turn with
 * no text model of its own uses to write an Overview Summary. A cloud setup or a
 * missing local model leaves the summary pending rather than sending History out.
 */
export function assistantLocalSummariser(language: string): Summariser {
  const textInference = useTextInference()
  const { inference } = textInference.inferenceForSettings(HARNESS_CHAT_PRESET, {})
  const backend = inference.backend
  if (backend !== 'llamaCPP' && backend !== 'openVINO') return { language }
  const activeModel = inference.activeModel ?? ''
  if (!activeModel) return { language }
  const model: ChatModelConfig = {
    backend,
    modelId: activeModel.split('/').join('---'),
    ...(inference.localBackendUrl ? { baseUrl: inference.localBackendUrl } : {}),
    readiness: {
      serviceName: backendToService[backend],
      llmModelName: activeModel,
      contextSize: inference.contextSize,
      ...(backend === 'llamaCPP' && inference.activeLlmModel?.llamaCppArgs
        ? { modelArgs: inference.activeLlmModel.llamaCppArgs }
        : {}),
    },
    ...(inference.samplingRequestBody
      ? { samplingRequestBody: inference.samplingRequestBody }
      : {}),
    chatTemplateKwargs: chatTemplateKwargs({
      supportsThinkingToggle: inference.modelSupportsThinkingToggle,
      thinkingEnabled: inference.thinkingEnabled,
      thinkingActive: inference.thinkingActive,
      reasoningEffort: inference.effectiveReasoningEffort as ReasoningEffort | undefined,
    }),
    temperature: inference.temperature,
    ...(inference.effectiveMaxTokens ? { maxOutputTokens: inference.effectiveMaxTokens } : {}),
    supportsVision: inference.modelSupportsVision,
    timingsPerToken: true,
  }
  return { model, language }
}

/** The Session's frozen reply language when it has one, else the live UI language. */
export function summariserLanguage(): string {
  const i18n = useI18N()
  return useSessions().openSession?.responseLocale ?? i18n.langName
}

/** The summariser a media or audio turn ships: the Assistant preset's local model. */
export function turnSummariser(): Summariser {
  return assistantLocalSummariser(summariserLanguage())
}
