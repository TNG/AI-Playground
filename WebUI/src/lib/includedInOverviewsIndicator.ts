import type { SessionSummary } from '@/types/sessionIpc'

export type IncludedInOverviewsIndicator = { included: boolean }

/** What the prompt bar's "Included in Overviews" chip shows for the open Session. */
export function includedInOverviewsIndicator(
  session: Pick<SessionSummary, 'includedInOverviews' | 'unreadable'> | null,
): IncludedInOverviewsIndicator | null {
  if (!session || session.unreadable) return null
  return { included: session.includedInOverviews }
}
