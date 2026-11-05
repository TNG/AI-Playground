import type { SessionGroup, SessionSummary } from '@/types/sessionIpc'

export type SessionGroupListing = {
  group: SessionGroup
  sessions: SessionSummary[]
  expanded: boolean
  holdsOpen: boolean
}

/** The button row under the pinned rows: "Show N more" or "Show less". */
export type PinnedToggle = { action: 'more'; count: number } | { action: 'less' } | null

export type SessionSection =
  | { id: 'pinned'; sessions: SessionSummary[]; toggle: PinnedToggle }
  | { id: 'groups'; groups: SessionGroupListing[] }
  | { id: DateBucket; sessions: SessionSummary[] }

export type DateBucket = 'today' | 'yesterday' | 'previous7Days' | 'older'

export type SessionSectionId = SessionSection['id']

export type SessionSectionsInput = {
  sessions: SessionSummary[]
  groups: SessionGroup[]
  query: string
  /** The Title the panel shows for a Session that has none yet. */
  untitled: string
  openSessionId: string | null
  pinnedShowMore: boolean
  now: number
  /** Sessions with a turn running, queued or paused: they are listed under Today. */
  liveSessionIds: ReadonlySet<string>
}

const DATE_BUCKETS: DateBucket[] = ['today', 'yesterday', 'previous7Days', 'older']
const DAY_MS = 24 * 60 * 60 * 1000

const PINNED_SHOWN = 3

function pinnedSection(
  pinned: SessionSummary[],
  searching: boolean,
  openSessionId: string | null,
  showMore: boolean,
): SessionSection {
  if (searching || pinned.length <= PINNED_SHOWN) {
    return { id: 'pinned', sessions: pinned, toggle: null }
  }
  if (showMore) return { id: 'pinned', sessions: pinned, toggle: { action: 'less' } }
  const shown = pinned.filter((s, index) => index < PINNED_SHOWN || s.id === openSessionId)
  const count = pinned.length - shown.length
  return { id: 'pinned', sessions: shown, toggle: count > 0 ? { action: 'more', count } : null }
}

function newestFirst(a: SessionSummary, b: SessionSummary): number {
  return b.updatedAt - a.updatedAt || b.createdAt - a.createdAt
}

/** Whole local calendar days from `time` to `now`; a daylight-saving change cannot shift it. */
function calendarDaysBack(time: number, now: number): number {
  const day = (t: number) => {
    const d = new Date(t)
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  }
  return Math.round((day(now) - day(time)) / DAY_MS)
}

function dateBucket(time: number, now: number): DateBucket {
  const days = calendarDaysBack(time, now)
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days <= 7) return 'previous7Days'
  return 'older'
}

export function sessionSections({
  sessions,
  groups,
  query,
  untitled,
  openSessionId,
  pinnedShowMore,
  now,
  liveSessionIds,
}: SessionSectionsInput): SessionSection[] {
  const needle = query.trim().toLocaleLowerCase()
  const contains = (text: string) => text.toLocaleLowerCase().includes(needle)
  const matches = (s: SessionSummary) => !needle || contains(s.title || untitled)
  const ordered = [...sessions].sort(newestFirst)
  const known = new Set(groups.map((group) => group.id))
  const groupOf = (s: SessionSummary) =>
    !s.unreadable && s.groupId !== undefined && known.has(s.groupId) ? s.groupId : null

  const pinned = ordered.filter((s) => !s.unreadable && s.pinned && matches(s))
  const recent = ordered.filter(
    (s) => (s.unreadable || (!s.pinned && groupOf(s) === null)) && matches(s),
  )
  const listings = groups
    .map((group) => {
      const members = ordered.filter((s) => groupOf(s) === group.id)
      const nameMatches = !!needle && contains(group.name)
      const shown = nameMatches ? members : members.filter(matches)
      return {
        listing: {
          group,
          sessions: shown,
          expanded: group.expanded || !!needle,
          holdsOpen: members.some((s) => s.id === openSessionId),
        },
        newest: members[0],
        listed: !needle || nameMatches || shown.length > 0,
      }
    })
    .filter(({ listed }) => listed)
    .sort((a, b) => {
      if (a.newest && b.newest) return newestFirst(a.newest, b.newest)
      if (a.newest || b.newest) return a.newest ? -1 : 1
      return b.listing.group.createdAt - a.listing.group.createdAt
    })
    .map(({ listing }) => listing)

  const result: SessionSection[] = []
  if (pinned.length > 0) {
    result.push(pinnedSection(pinned, needle !== '', openSessionId, pinnedShowMore))
  }
  if (listings.length > 0) result.push({ id: 'groups', groups: listings })
  const bucketOf = (s: SessionSummary) =>
    liveSessionIds.has(s.id) ? 'today' : dateBucket(s.updatedAt, now)
  for (const bucket of DATE_BUCKETS) {
    const listed = recent.filter((s) => bucketOf(s) === bucket)
    if (listed.length > 0) result.push({ id: bucket, sessions: listed })
  }
  return result
}

/** The collapsed Group to expand when this Session is opened, so the open Session is in view. */
export function groupToRevealOnOpen(
  session: SessionSummary,
  groups: SessionGroup[],
): string | null {
  if (session.pinned || session.unreadable) return null
  const group = groups.find((g) => g.id === session.groupId)
  return group && !group.expanded ? group.id : null
}
