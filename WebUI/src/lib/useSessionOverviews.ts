import { computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useSessions } from '@/assets/js/store/sessions'
import { buildChatModelConfig } from '@/lib/chatModel'
import { includedInOverviewsIndicator } from '@/lib/includedInOverviewsIndicator'
import type { OverviewSummaryRequest } from '@/types/sessionIpc'

/** Whether the open Session may appear in Overviews, from the prompt bar. */
export function useSessionOverviews() {
  const sessions = useSessions()
  const i18n = useI18N()

  const indicator = computed(() => includedInOverviewsIndicator(sessions.openSession))

  /** The renderer resolves the summariser; a cloud setup sends no model (summaries are local). */
  function summaryRequest(): OverviewSummaryRequest {
    const model = buildChatModelConfig()
    return {
      language: i18n.langName,
      ...(model.backend === 'cloud' ? {} : { model }),
    }
  }

  async function activate(): Promise<void> {
    const state = indicator.value
    const sessionRef = sessions.openSessionId
    if (!state || !sessionRef) return
    await sessions.setIncludedInOverviews(
      sessionRef,
      !state.included,
      state.included ? { language: i18n.langName } : summaryRequest(),
    )
  }

  return { indicator, activate }
}
