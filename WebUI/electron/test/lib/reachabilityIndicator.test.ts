import { describe, expect, it } from 'vitest'
import { reachabilityIndicator } from '@/lib/reachabilityIndicator'

describe('reachabilityIndicator', () => {
  it('toggles an open Session on and off once a Channel is set up', () => {
    expect(
      reachabilityIndicator({
        session: { reachable: false },
        channelsSetUp: true,
        realShell: false,
      }),
    ).toEqual({ action: 'toggle', reachable: false })
    expect(
      reachabilityIndicator({
        session: { reachable: true },
        channelsSetUp: true,
        realShell: false,
      }),
    ).toEqual({ action: 'toggle', reachable: true })
  })

  it('sends to Channels setup when no Channel is set up, but still lets a reachable Session off', () => {
    expect(
      reachabilityIndicator({
        session: { reachable: false },
        channelsSetUp: false,
        realShell: false,
      }),
    ).toEqual({ action: 'setUp' })
    expect(
      reachabilityIndicator({
        session: { reachable: true },
        channelsSetUp: false,
        realShell: false,
      }),
    ).toEqual({ action: 'toggle', reachable: true })
  })

  it('cannot turn on a Session that uses the real system shell, only off', () => {
    expect(
      reachabilityIndicator({
        session: { reachable: false },
        channelsSetUp: true,
        realShell: true,
      }),
    ).toEqual({ action: 'blocked', reason: 'realShell' })
    expect(
      reachabilityIndicator({
        session: { reachable: true },
        channelsSetUp: true,
        realShell: true,
      }),
    ).toEqual({ action: 'toggle', reachable: true })
  })

  it('asks for a Channel before it explains the real shell', () => {
    expect(
      reachabilityIndicator({
        session: { reachable: false },
        channelsSetUp: false,
        realShell: true,
      }),
    ).toEqual({ action: 'setUp' })
  })

  it('shows nothing where no Session is open, or its file cannot be read', () => {
    expect(reachabilityIndicator({ session: null, channelsSetUp: true, realShell: false })).toBe(
      null,
    )
    expect(
      reachabilityIndicator({
        session: { reachable: false, unreadable: true },
        channelsSetUp: true,
        realShell: false,
      }),
    ).toBe(null)
  })
})
