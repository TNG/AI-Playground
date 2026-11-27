import type { TimeLabelBucket } from '@/lib/sessionTimeLabel'
import type { SessionGroup, SessionSummary, ShowMore } from '@/types/sessionIpc'

export type SessionGroupListing = {
  group: SessionGroup
  sessions: SessionSummary[]
  expanded: boolean
  holdsOpen: boolean
}

/** The button row under a shortened section: "Show N more" or "Show less". */
export type ShowMoreToggle = { action: 'more'; count: number } | { action: 'less' } | null

export type SessionSection =
  | { id: 'pinned'; sessions: SessionSummary[]; toggle: ShowMoreToggle }
  | { id: 'groups'; groups: SessionGroupListing[] }
  | { id: Exclude<DateBucket, 'older'>; sessions: SessionSummary[] }
  | { id: 'older'; sessions: SessionSummary[]; toggle: ShowMoreToggle }

export type DateBucket = 'today' | 'yesterday' | 'previous7Days' | 'older'

export type SessionSectionId = SessionSection['id']

export type SessionSectionsInput = {
  sessions: SessionSummary[]
  groups: SessionGroup[]
  query: string
  /** The Title the panel shows for a Session that has none yet. */
  untitled: string
  openSessionId: string | null
  showMore: ShowMore
  now: number
  /** Sessions with a turn running, queued or paused. */
  liveSessionIds: ReadonlySet<string>
}

const DATE_BUCKETS: DateBucket[] = ['today', 'yesterday', 'previous7Days', 'older']
const DAY_MS = 24 * 60 * 60 * 1000

const PINNED_SHOWN = 3
const OLDER_SHOWN = 5

/** The first `limit` rows plus the open Session in its place, unless searching or shown in full. */
function shortened(
  listed: SessionSummary[],
  {
    limit,
    searching,
    openSessionId,
    showMore,
  }: { limit: number; searching: boolean; openSessionId: string | null; showMore: boolean },
): { sessions: SessionSummary[]; toggle: ShowMoreToggle } {
  if (searching || listed.length <= limit) return { sessions: listed, toggle: null }
  if (showMore) return { sessions: listed, toggle: { action: 'less' } }
  const shown = listed.filter((s, index) => index < limit || s.id === openSessionId)
  const count = listed.length - shown.length
  return { sessions: shown, toggle: count > 0 ? { action: 'more', count } : null }
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
  showMore,
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

  const searching = needle !== ''
  const result: SessionSection[] = []
  if (pinned.length > 0) {
    const pinnedRows = shortened(pinned, {
      limit: PINNED_SHOWN,
      searching,
      openSessionId,
      showMore: showMore.pinned,
    })
    result.push({ id: 'pinned', ...pinnedRows })
  }
  if (listings.length > 0) result.push({ id: 'groups', groups: listings })
  const bucketOf = (s: SessionSummary) =>
    liveSessionIds.has(s.id) ? 'today' : dateBucket(s.updatedAt, now)
  for (const bucket of DATE_BUCKETS) {
    const listed = recent.filter((s) => bucketOf(s) === bucket)
    if (listed.length === 0) continue
    if (bucket === 'older') {
      const olderRows = shortened(listed, {
        limit: OLDER_SHOWN,
        searching,
        openSessionId,
        showMore: showMore.older,
      })
      result.push({ id: bucket, ...olderRows })
    } else {
      result.push({ id: bucket, sessions: listed })
    }
  }
  return result
}

export function sectionTimeBucket(id: SessionSectionId): TimeLabelBucket {
  return id === 'pinned' || id === 'groups' ? 'relative' : id
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
