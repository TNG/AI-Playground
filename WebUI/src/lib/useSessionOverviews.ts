import { computed } from 'vue'
import { useSessions } from '@/assets/js/store/sessions'
import { assistantLocalSummariser, summariserLanguage } from '@/lib/turnSummariser'
import { includedInOverviewsIndicator } from '@/lib/includedInOverviewsIndicator'
import type { Summariser } from '@/types/sessionIpc'

/** Whether the open Session may appear in Overviews, from the prompt bar. */
export function useSessionOverviews() {
  const sessions = useSessions()

  const indicator = computed(() => includedInOverviewsIndicator(sessions.openSession))

  /** The renderer resolves the Assistant preset's local model; a cloud setup sends none. */
  function summaryRequest(): Summariser {
    return assistantLocalSummariser(summariserLanguage())
  }

  async function activate(): Promise<void> {
    const state = indicator.value
    const sessionRef = sessions.openSessionId
    if (!state || !sessionRef) return
    await sessions.setIncludedInOverviews(
      sessionRef,
      !state.included,
      state.included ? { language: summariserLanguage() } : summaryRequest(),
    )
  }

  /** The chip's Retry: only the Session's summary state moves, not any turn's row. */
  async function retry(): Promise<void> {
    const sessionRef = sessions.openSessionId
    if (!sessionRef) return
    await sessions.refreshOverviewSummary(sessionRef, summaryRequest())
  }

  /** A turn's failed row: rerun the update and write the new outcome back onto that entry. */
  async function retryUpdate(entryId: string): Promise<void> {
    const sessionRef = sessions.openSessionId
    if (!sessionRef) return
    await sessions.retryOverviewUpdate(sessionRef, entryId, summaryRequest())
  }

  /** On launch, pick up the pending markers an interrupted run left behind. */
  async function resumePending(): Promise<void> {
    await sessions.resumePendingOverviewUpdates(summaryRequest())
  }

  return { indicator, activate, retry, retryUpdate, resumePending, summaryRequest }
}
