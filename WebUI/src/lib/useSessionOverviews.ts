import { computed } from 'vue'
import { useSessions } from '@/assets/js/store/sessions'
import { includedInOverviewsIndicator } from '@/lib/includedInOverviewsIndicator'

/** Whether the open Session may appear in Overviews, from the prompt bar. */
export function useSessionOverviews() {
  const sessions = useSessions()

  const indicator = computed(() => includedInOverviewsIndicator(sessions.openSession))

  async function activate(): Promise<void> {
    const state = indicator.value
    const sessionRef = sessions.openSessionId
    if (!state || !sessionRef) return
    await sessions.setIncludedInOverviews(sessionRef, !state.included)
  }

  return { indicator, activate }
}
