import { useI18N } from '@/assets/js/store/i18n'
import { buildChatModelConfig } from '@/lib/chatModel'
import type { TurnSummariser } from '@/types/sessionIpc'

/**
 * The summariser a media or audio turn ships: a turn with no text model of its
 * own uses the Assistant preset's local model, and a cloud setup ships none so
 * the summary stays behind rather than leaving the machine.
 */
export function turnSummariser(): TurnSummariser {
  const i18n = useI18N()
  const model = buildChatModelConfig()
  const readiness = model.backend === 'cloud' ? undefined : model.readiness
  return {
    ...(readiness?.llmModelName ? { readiness } : {}),
    replyLanguage: i18n.langName,
  }
}
