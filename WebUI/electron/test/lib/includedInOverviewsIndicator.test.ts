import { describe, expect, it } from 'vitest'
import { includedInOverviewsIndicator } from '@/lib/includedInOverviewsIndicator'

describe('includedInOverviewsIndicator', () => {
  it('is off for a Session that is not included', () => {
    expect(includedInOverviewsIndicator({ includedInOverviews: false })).toEqual({
      included: false,
      state: 'off',
    })
  })

  it('is included when the Session has no summary yet', () => {
    expect(includedInOverviewsIndicator({ includedInOverviews: true })).toEqual({
      included: true,
      state: 'included',
    })
  })

  it.each(['pending', 'ready', 'failed'] as const)('carries the %s state', (state) => {
    expect(
      includedInOverviewsIndicator({ includedInOverviews: true, overviewSummaryState: state }),
    ).toEqual({ included: true, state })
  })

  it('shows nothing for an unreadable Session or no Session', () => {
    expect(includedInOverviewsIndicator(null)).toBeNull()
    expect(includedInOverviewsIndicator({ includedInOverviews: true, unreadable: true })).toBeNull()
  })
})
