import type { OverviewSummaryState, SessionSummary } from '@/types/sessionIpc'

/** The chip's state: off, included with no summary, or the stored summary's state. */
export type IncludedInOverviewsState = 'off' | 'included' | OverviewSummaryState

export type IncludedInOverviewsIndicator = {
  included: boolean
  state: IncludedInOverviewsState
}

/** What the prompt bar's "Included in Overviews" chip shows for the open Session. */
export function includedInOverviewsIndicator(
  session: Pick<
    SessionSummary,
    'includedInOverviews' | 'unreadable' | 'overviewSummaryState'
  > | null,
): IncludedInOverviewsIndicator | null {
  if (!session || session.unreadable) return null
  if (!session.includedInOverviews) return { included: false, state: 'off' }
  return { included: true, state: session.overviewSummaryState ?? 'included' }
}
