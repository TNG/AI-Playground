import type { SessionSummary } from '@/types/sessionIpc'

export type ReachabilityIndicator =
  | { action: 'toggle'; reachable: boolean }
  | { action: 'setUp' }
  | { action: 'blocked'; reason: 'realShell' }

export type ReachabilityInput = {
  session: Pick<SessionSummary, 'reachable' | 'unreadable'> | null
  channelsSetUp: boolean
  realShell: boolean
}

/** What the prompt bar's "Reachable from Channels" indicator shows and does for the open Session. */
export function reachabilityIndicator({
  session,
  channelsSetUp,
  realShell,
}: ReachabilityInput): ReachabilityIndicator | null {
  if (!session || session.unreadable) return null
  if (session.reachable) return { action: 'toggle', reachable: true }
  if (!channelsSetUp) return { action: 'setUp' }
  if (realShell) return { action: 'blocked', reason: 'realShell' }
  return { action: 'toggle', reachable: false }
}
