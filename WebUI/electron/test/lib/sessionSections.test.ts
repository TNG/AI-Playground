import { describe, expect, it } from 'vitest'
import { groupToRevealOnOpen, sessionSections, type SessionSection } from '@/lib/sessionSections'
import type { SessionGroup, SessionSummary } from '@/types/sessionIpc'

const UNTITLED = 'Untitled Session'

function session(id: string, over: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id,
    title: id,
    renamed: false,
    pinned: false,
    createdAt: 0,
    updatedAt: 0,
    presetsUsed: [],
    ...over,
  }
}

function group(id: string, over: Partial<SessionGroup> = {}): SessionGroup {
  return { id, name: id, createdAt: 0, expanded: true, ...over }
}

function sections(
  sessions: SessionSummary[],
  query = '',
  groups: SessionGroup[] = [],
  view: {
    openSessionId?: string | null
    pinnedShowMore?: boolean
    olderShowMore?: boolean
    now?: number
    liveSessionIds?: string[]
  } = {},
) {
  return sessionSections({
    sessions,
    groups,
    query,
    untitled: UNTITLED,
    openSessionId: view.openSessionId ?? null,
    pinnedShowMore: view.pinnedShowMore ?? false,
    olderShowMore: view.olderShowMore ?? false,
    now: view.now ?? NOW,
    liveSessionIds: new Set(view.liveSessionIds ?? []),
  })
}

/** Tuesday 10 March 2026, 12:00 local time. */
const NOW = new Date(2026, 2, 10, 12, 0).getTime()

function at(day: number, hour = 12, minute = 0) {
  return new Date(2026, 2, day, hour, minute).getTime()
}

function holdsOpenOf(result: SessionSection[]) {
  const listed = result.find((section) => section.id === 'groups')
  if (listed?.id !== 'groups') return {}
  return Object.fromEntries(listed.groups.map((l) => [l.group.id, l.holdsOpen]))
}

function pinnedOf(result: SessionSection[]) {
  const pinned = result.find((section) => section.id === 'pinned')
  if (pinned?.id !== 'pinned') throw new Error('no Pinned section')
  return { ids: pinned.sessions.map((s) => s.id), toggle: pinned.toggle }
}

function olderOf(result: SessionSection[]) {
  const older = result.find((section) => section.id === 'older')
  if (older?.id !== 'older') throw new Error('no Older section')
  return { ids: older.sessions.map((s) => s.id), toggle: older.toggle }
}

/** Seven Sessions from February, o1 the most recently used. */
const sevenOld = [1, 2, 3, 4, 5, 6, 7].map((n) => session(`o${n}`, { updatedAt: at(-n) }))

/** Five pinned Sessions, p1 the most recently used. */
const fivePins = [5, 4, 3, 2, 1].map((n) => session(`p${6 - n}`, { pinned: true, updatedAt: n }))

function ids(result: SessionSection[]) {
  return result.map((section) =>
    section.id === 'groups'
      ? [section.id, section.groups.map((g) => [g.group.id, g.sessions.map((s) => s.id)])]
      : [section.id, section.sessions.map((s) => s.id)],
  )
}

describe('sessionSections', () => {
  it('lists Sessions in a bucket newest turn first', () => {
    const sessions = [
      session('old', { updatedAt: 1 }),
      session('new', { updatedAt: 3 }),
      session('mid', { updatedAt: 2 }),
    ]
    expect(ids(sections(sessions))).toEqual([['older', ['new', 'mid', 'old']]])
  })

  it('breaks a tie in last turn by the newer Session', () => {
    const sessions = [
      session('first', { createdAt: 1, updatedAt: 5 }),
      session('second', { createdAt: 2, updatedAt: 5 }),
    ]
    expect(ids(sections(sessions))).toEqual([['older', ['second', 'first']]])
  })

  it('shows no sections when there are no Sessions', () => {
    expect(sections([])).toEqual([])
  })

  it('narrows to Titles containing the query, ignoring case and surrounding spaces', () => {
    const sessions = [
      session('a', { title: 'Sunset over Lisbon', updatedAt: 2 }),
      session('b', { title: 'Grocery list', updatedAt: 3 }),
      session('c', { title: 'LISBON trip plan', updatedAt: 1 }),
    ]
    expect(ids(sections(sessions, '  lisbon '))).toEqual([['older', ['a', 'c']]])
  })

  it('matches an untitled Session by the Title the panel shows for it', () => {
    const sessions = [session('blank', { title: '' }), session('named', { title: 'Logo ideas' })]
    expect(ids(sections(sessions, 'untitled'))).toEqual([['older', ['blank']]])
  })

  it('shows no sections when nothing matches', () => {
    expect(sections([session('a', { title: 'Logo' })], 'xyz')).toEqual([])
  })

  it('lists everything for a blank query', () => {
    expect(ids(sections([session('a', { title: 'Logo' })], '   '))).toEqual([['older', ['a']]])
  })

  it('lists a Session the user named in Older, where it was before its Name', () => {
    const sessions = [
      session('plain', { updatedAt: 1 }),
      session('named', { title: 'Foxes', renamed: true, updatedAt: 2 }),
    ]
    expect(ids(sections(sessions))).toEqual([['older', ['named', 'plain']]])
  })

  it('keeps an unreadable Session in Older', () => {
    const sessions = [
      session('broken', { title: 'Unavailable session', unreadable: true, updatedAt: 2 }),
      session('pinned', { pinned: true, updatedAt: 1 }),
    ]
    expect(ids(sections(sessions))).toEqual([
      ['pinned', ['pinned']],
      ['older', ['broken']],
    ])
  })

  it('lists Pinned above the date buckets, newest turn first', () => {
    const sessions = [
      session('recent', { updatedAt: 6 }),
      session('pinned-old', { pinned: true, updatedAt: 1 }),
      session('pinned-new', { pinned: true, updatedAt: 3 }),
    ]
    expect(ids(sections(sessions))).toEqual([
      ['pinned', ['pinned-new', 'pinned-old']],
      ['older', ['recent']],
    ])
  })

  it('pins an untitled Session too', () => {
    expect(ids(sections([session('blank', { title: '', pinned: true })]))).toEqual([
      ['pinned', ['blank']],
    ])
  })

  it('lists Groups between Pinned and the date buckets, each with its Sessions newest first', () => {
    const sessions = [
      session('recent', { updatedAt: 9 }),
      session('pinned', { pinned: true, updatedAt: 1 }),
      session('in-old', { groupId: 'trip', updatedAt: 2 }),
      session('in-new', { groupId: 'trip', updatedAt: 4 }),
    ]
    expect(ids(sections(sessions, '', [group('trip')]))).toEqual([
      ['pinned', ['pinned']],
      ['groups', [['trip', ['in-new', 'in-old']]]],
      ['older', ['recent']],
    ])
  })

  it('lists a pinned, grouped Session under Pinned and in its Group', () => {
    const sessions = [session('both', { pinned: true, groupId: 'trip', updatedAt: 1 })]
    expect(ids(sections(sessions, '', [group('trip')]))).toEqual([
      ['pinned', ['both']],
      ['groups', [['trip', ['both']]]],
    ])
  })

  it('orders Groups by their newest member, pinned members included', () => {
    const sessions = [
      session('a1', { groupId: 'a', updatedAt: 3 }),
      session('b-pinned', { groupId: 'b', pinned: true, updatedAt: 5 }),
      session('b1', { groupId: 'b', updatedAt: 1 }),
      session('c1', { groupId: 'c', updatedAt: 4 }),
    ]
    const groups = [group('a'), group('b'), group('c')]
    expect(ids(sections(sessions, '', groups))).toEqual([
      ['pinned', ['b-pinned']],
      [
        'groups',
        [
          ['b', ['b-pinned', 'b1']],
          ['c', ['c1']],
          ['a', ['a1']],
        ],
      ],
    ])
  })

  it('lists empty Groups after the others, newest Group first', () => {
    const sessions = [session('a1', { groupId: 'a', updatedAt: 1 })]
    const groups = [
      group('empty-old', { createdAt: 5 }),
      group('a', { createdAt: 1 }),
      group('empty-new', { createdAt: 9 }),
    ]
    expect(ids(sections(sessions, '', groups))).toEqual([
      [
        'groups',
        [
          ['a', ['a1']],
          ['empty-new', []],
          ['empty-old', []],
        ],
      ],
    ])
  })

  function expandedOf(result: SessionSection[]) {
    const groupsSection = result.find((section) => section.id === 'groups')
    return groupsSection?.id === 'groups'
      ? Object.fromEntries(groupsSection.groups.map((g) => [g.group.id, g.expanded]))
      : {}
  }

  it('renders each Group as expanded or collapsed as it was stored', () => {
    const sessions = [session('a1', { groupId: 'a' }), session('b1', { groupId: 'b' })]
    const groups = [group('a', { expanded: false }), group('b', { expanded: true })]
    expect(expandedOf(sections(sessions, '', groups))).toEqual({ a: false, b: true })
  })

  it('keeps a collapsed Group collapsed while the open Session is in it, and marks it', () => {
    const sessions = [session('a1', { groupId: 'a' }), session('b1', { groupId: 'b' })]
    const groups = [group('a', { expanded: false }), group('b', { expanded: false })]
    const result = sections(sessions, '', groups, { openSessionId: 'a1' })
    expect(expandedOf(result)).toEqual({ a: false, b: false })
    expect(holdsOpenOf(result)).toEqual({ a: true, b: false })
  })

  it('renders matching Groups expanded while searching', () => {
    const sessions = [session('a1', { title: 'Lisbon', groupId: 'a' })]
    const groups = [group('a', { expanded: false })]
    expect(expandedOf(sections(sessions, 'lisbon', groups))).toEqual({ a: true })
  })

  it('lists a Session whose Group cannot be found in Older', () => {
    const sessions = [
      session('lost', { groupId: 'gone' }),
      session('pinned-lost', { pinned: true, groupId: 'gone' }),
    ]
    expect(ids(sections(sessions, '', [group('other')]))).toEqual([
      ['pinned', ['pinned-lost']],
      ['groups', [['other', []]]],
      ['older', ['lost']],
    ])
  })

  it('lists an unreadable Session in Older even if it claims a Group', () => {
    const sessions = [session('broken', { unreadable: true, groupId: 'trip' })]
    expect(ids(sections(sessions, '', [group('trip')]))).toEqual([
      ['groups', [['trip', []]]],
      ['older', ['broken']],
    ])
  })

  it('shows no Groups section without Groups', () => {
    expect(ids(sections([session('a')], '', []))).toEqual([['older', ['a']]])
  })

  it('narrows Group members by Title while searching and hides Groups left empty', () => {
    const sessions = [
      session('hit', { title: 'Lisbon photos', groupId: 'trip' }),
      session('miss', { title: 'Packing', groupId: 'trip' }),
    ]
    const groups = [group('trip'), group('empty')]
    expect(ids(sections(sessions, 'lisbon', groups))).toEqual([['groups', [['trip', ['hit']]]]])
  })

  it('lists every member of a Group whose name matches, pinned members included', () => {
    const sessions = [
      session('photos', { title: 'Photos', groupId: 'trip', updatedAt: 2 }),
      session('packing', { title: 'Packing', groupId: 'trip', pinned: true, updatedAt: 1 }),
      session('other', { title: 'Other' }),
    ]
    const groups = [group('trip', { name: 'Lisbon Trip' })]
    expect(ids(sections(sessions, '  lisbon ', groups))).toEqual([
      ['groups', [['trip', ['photos', 'packing']]]],
    ])
  })

  it('shows an empty Group whose name matches while searching, hiding the empty ones that do not', () => {
    const groups = [group('trip', { name: 'Lisbon' }), group('other', { name: 'Porto' })]
    expect(ids(sections([session('a', { title: 'Lisbon notes' })], 'lisbon', groups))).toEqual([
      ['groups', [['trip', []]]],
      ['older', ['a']],
    ])
  })

  it('renders a Group whose name matches expanded while searching, leaving its stored state', () => {
    const stored = group('trip', { name: 'Lisbon', expanded: false })
    const result = sections([session('a1', { groupId: 'trip' })], 'lisbon', [stored])
    expect(expandedOf(result)).toEqual({ trip: true })
    expect(stored.expanded).toBe(false)
    expect(expandedOf(sections([session('a1', { groupId: 'trip' })], '', [stored]))).toEqual({
      trip: false,
    })
  })

  describe('date buckets', () => {
    it('buckets Recent Sessions by the local calendar day of their last turn', () => {
      const sessions = [
        session('midnight', { updatedAt: at(10, 0, 0) }),
        session('late-yesterday', { updatedAt: at(9, 23, 59) }),
        session('early-yesterday', { updatedAt: at(9, 0, 0) }),
        session('two-days', { updatedAt: at(8, 23, 59) }),
        session('seven-days', { updatedAt: at(3, 0, 0) }),
        session('eight-days', { updatedAt: at(2, 23, 59) }),
      ]
      expect(ids(sections(sessions))).toEqual([
        ['today', ['midnight']],
        ['yesterday', ['late-yesterday', 'early-yesterday']],
        ['previous7Days', ['two-days', 'seven-days']],
        ['older', ['eight-days']],
      ])
    })

    it('lists a Session with a running, queued or paused turn under Today, in its place by date', () => {
      const sessions = [
        session('today', { updatedAt: at(10, 9) }),
        session('live-last-month', { updatedAt: new Date(2026, 1, 3).getTime() }),
        session('settled-last-month', { updatedAt: new Date(2026, 1, 2).getTime() }),
      ]
      expect(ids(sections(sessions, '', [], { liveSessionIds: ['live-last-month'] }))).toEqual([
        ['today', ['today', 'live-last-month']],
        ['older', ['settled-last-month']],
      ])
    })

    it('keeps a Session in its calendar day across a daylight-saving change', () => {
      const zone = process.env.TZ
      process.env.TZ = 'Europe/Berlin'
      try {
        const now = new Date(2026, 2, 30, 0, 30).getTime()
        const sessions = [
          session('before-the-switch', { updatedAt: new Date(2026, 2, 28, 23, 30).getTime() }),
        ]
        expect(ids(sections(sessions, '', [], { now }))).toEqual([
          ['previous7Days', ['before-the-switch']],
        ])
      } finally {
        process.env.TZ = zone
      }
    })

    it('shows a lone bucket with its heading and leaves empty buckets out', () => {
      expect(ids(sections([session('a', { updatedAt: at(10, 8) })]))).toEqual([['today', ['a']]])
      expect(ids(sections([session('a', { updatedAt: at(5) })]))).toEqual([
        ['previous7Days', ['a']],
      ])
    })

    it('orders each bucket newest turn first, the newer Session breaking a tie', () => {
      const sessions = [
        session('first', { createdAt: 1, updatedAt: at(9, 10) }),
        session('second', { createdAt: 2, updatedAt: at(9, 10) }),
        session('latest', { createdAt: 0, updatedAt: at(9, 20) }),
      ]
      expect(ids(sections(sessions))).toEqual([['yesterday', ['latest', 'second', 'first']]])
    })

    it('lists a Session with no turn yet by when it was created', () => {
      const fresh = session('fresh', { createdAt: at(10, 11), updatedAt: at(10, 11) })
      expect(ids(sections([fresh]))).toEqual([['today', ['fresh']]])
    })

    it('buckets an unreadable Session by the time it reports', () => {
      const broken = session('broken', { unreadable: true, pinned: true, updatedAt: at(9, 8) })
      expect(ids(sections([broken]))).toEqual([['yesterday', ['broken']]])
    })

    it('does not split Pinned Sessions or Session Groups by date', () => {
      const sessions = [
        session('pin-today', { pinned: true, updatedAt: at(10, 9) }),
        session('pin-old', { pinned: true, updatedAt: at(1) }),
        session('in-today', { groupId: 'trip', updatedAt: at(10, 8) }),
        session('in-old', { groupId: 'trip', updatedAt: at(1) }),
        session('loose', { updatedAt: at(9) }),
      ]
      expect(ids(sections(sessions, '', [group('trip')]))).toEqual([
        ['pinned', ['pin-today', 'pin-old']],
        ['groups', [['trip', ['in-today', 'in-old']]]],
        ['yesterday', ['loose']],
      ])
    })

    it('keeps the headings while searching, each bucket narrowed to its matches', () => {
      const sessions = [
        session('today-hit', { title: 'Lisbon walk', updatedAt: at(10, 9) }),
        session('today-miss', { title: 'Groceries', updatedAt: at(10, 8) }),
        session('yesterday-miss', { title: 'Packing', updatedAt: at(9) }),
        session('older-hit', { title: 'LISBON flights', updatedAt: at(1) }),
      ]
      expect(ids(sections(sessions, 'lisbon'))).toEqual([
        ['today', ['today-hit']],
        ['older', ['older-hit']],
      ])
    })
  })

  describe('Pinned "show more"', () => {
    it('shows the three most recent pins and counts the rest', () => {
      expect(pinnedOf(sections(fivePins))).toEqual({
        ids: ['p1', 'p2', 'p3'],
        toggle: { action: 'more', count: 2 },
      })
    })

    it('shows every pin with a way back once shown', () => {
      expect(pinnedOf(sections(fivePins, '', [], { pinnedShowMore: true }))).toEqual({
        ids: ['p1', 'p2', 'p3', 'p4', 'p5'],
        toggle: { action: 'less' },
      })
    })

    it('offers no toggle with three pins or fewer, whatever was chosen', () => {
      const three = fivePins.slice(0, 3)
      expect(pinnedOf(sections(three)).toggle).toBeNull()
      expect(pinnedOf(sections(three, '', [], { pinnedShowMore: true })).toggle).toBeNull()
    })

    it('adds the open Session as an extra row when it ranks lower', () => {
      expect(pinnedOf(sections(fivePins, '', [], { openSessionId: 'p5' }))).toEqual({
        ids: ['p1', 'p2', 'p3', 'p5'],
        toggle: { action: 'more', count: 1 },
      })
    })

    it('does not list the open Session twice when it is among the three', () => {
      expect(pinnedOf(sections(fivePins, '', [], { openSessionId: 'p2' }))).toEqual({
        ids: ['p1', 'p2', 'p3'],
        toggle: { action: 'more', count: 2 },
      })
    })

    it('adds no extra row for an open Session that is not pinned', () => {
      const sessions = [...fivePins, session('loose', { updatedAt: 0 })]
      expect(pinnedOf(sections(sessions, '', [], { openSessionId: 'loose' })).ids).toEqual([
        'p1',
        'p2',
        'p3',
      ])
    })

    it('offers no toggle when the open Session is the only pin left out', () => {
      const four = fivePins.slice(0, 4)
      expect(pinnedOf(sections(four, '', [], { openSessionId: 'p4' }))).toEqual({
        ids: ['p1', 'p2', 'p3', 'p4'],
        toggle: null,
      })
    })

    it('shows every matching pin while searching, without a toggle', () => {
      const sessions = fivePins.map((s) => ({ ...s, title: `Trip ${s.id}` }))
      expect(pinnedOf(sections(sessions, 'trip'))).toEqual({
        ids: ['p1', 'p2', 'p3', 'p4', 'p5'],
        toggle: null,
      })
    })
  })
})

describe('Older "show more"', () => {
  it('shows the five most recent Older Sessions and counts the rest', () => {
    expect(olderOf(sections(sevenOld))).toEqual({
      ids: ['o1', 'o2', 'o3', 'o4', 'o5'],
      toggle: { action: 'more', count: 2 },
    })
  })

  it('shows every Older Session with a way back once shown', () => {
    expect(olderOf(sections(sevenOld, '', [], { olderShowMore: true }))).toEqual({
      ids: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'],
      toggle: { action: 'less' },
    })
  })

  it('offers no toggle with five Older Sessions or fewer, whatever was chosen', () => {
    const five = sevenOld.slice(0, 5)
    expect(olderOf(sections(five)).toggle).toBeNull()
    expect(olderOf(sections(five, '', [], { olderShowMore: true })).toggle).toBeNull()
  })

  it('keeps the open Session in its place by date when it ranks lower', () => {
    const eight = [...sevenOld, session('o8', { updatedAt: at(-8) })]
    expect(olderOf(sections(eight, '', [], { openSessionId: 'o6' }))).toEqual({
      ids: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'],
      toggle: { action: 'more', count: 2 },
    })
  })

  it('offers no toggle when the open Session is the only one left out', () => {
    const six = sevenOld.slice(0, 6)
    expect(olderOf(sections(six, '', [], { openSessionId: 'o6' }))).toEqual({
      ids: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6'],
      toggle: null,
    })
  })

  it('shows every matching Older Session while searching, without a toggle', () => {
    const sessions = sevenOld.map((s) => ({ ...s, title: `Trip ${s.id}` }))
    expect(olderOf(sections(sessions, 'trip'))).toEqual({
      ids: ['o1', 'o2', 'o3', 'o4', 'o5', 'o6', 'o7'],
      toggle: null,
    })
  })

  it('never shortens Today, Yesterday or Previous 7 days', () => {
    const many = (prefix: string, day: number) =>
      [0, 1, 2, 3, 4, 5, 6].map((n) => session(`${prefix}${n}`, { updatedAt: at(day, 11, n) }))
    const result = sections([...many('t', 10), ...many('y', 9), ...many('w', 5)])
    expect(ids(result).map(([id, listed]) => [id, listed.length])).toEqual([
      ['today', 7],
      ['yesterday', 7],
      ['previous7Days', 7],
    ])
  })

  it('leaves Pinned to its own choice', () => {
    const sessions = [...fivePins.map((s) => ({ ...s, updatedAt: at(10) })), ...sevenOld]
    const result = sections(sessions, '', [], { olderShowMore: true })
    expect(pinnedOf(result).toggle).toEqual({ action: 'more', count: 2 })
    expect(olderOf(result).toggle).toEqual({ action: 'less' })
  })
})

describe('groupToRevealOnOpen', () => {
  const collapsed = [group('a', { expanded: false })]

  it('names the collapsed Group of a Session that is not pinned', () => {
    expect(groupToRevealOnOpen(session('a1', { groupId: 'a' }), collapsed)).toBe('a')
  })

  it('leaves the Groups alone when the Session is already in view', () => {
    expect(groupToRevealOnOpen(session('a1', { groupId: 'a', pinned: true }), collapsed)).toBeNull()
    expect(groupToRevealOnOpen(session('a1', { groupId: 'a' }), [group('a')])).toBeNull()
    expect(groupToRevealOnOpen(session('a1'), collapsed)).toBeNull()
    expect(groupToRevealOnOpen(session('a1', { groupId: 'gone' }), collapsed)).toBeNull()
  })
})
