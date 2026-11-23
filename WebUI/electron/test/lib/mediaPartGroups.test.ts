import { describe, expect, it } from 'vitest'

import { consecutiveMediaGroups } from '@/lib/mediaPartGroups'

const parts = [
  { kind: 'text' },
  { kind: 'media' },
  { kind: 'media' },
  { kind: 'text' },
  { kind: 'media' },
  { kind: 'other-tool' },
  { kind: 'media' },
  { kind: 'media' },
]

function isMedia(part: unknown): boolean {
  return (part as { kind: string }).kind === 'media'
}

describe('consecutiveMediaGroups', () => {
  it('merges a run of consecutive media parts into one group keyed at its start', () => {
    const groups = consecutiveMediaGroups(parts, isMedia)
    expect([...groups.entries()]).toEqual([
      [1, [1, 2]],
      [4, [4]],
      [6, [6, 7]],
    ])
  })

  it('treats every part as shown when no shown indexes are given', () => {
    expect([...consecutiveMediaGroups([{ kind: 'media' }], isMedia).entries()]).toEqual([[0, [0]]])
  })

  it('groups over the shown sequence, so parts hidden between two calls do not break a run', () => {
    const groups = consecutiveMediaGroups(parts, isMedia, [1, 2, 4, 6, 7])
    expect([...groups.entries()]).toEqual([[1, [1, 2, 4, 6, 7]]])
  })

  it('breaks the run at a part that is itself shown and not media', () => {
    const groups = consecutiveMediaGroups(parts, isMedia, [1, 2, 3, 4])
    expect([...groups.entries()]).toEqual([
      [1, [1, 2]],
      [4, [4]],
    ])
  })

  it('dedupes and orders the shown indexes', () => {
    const groups = consecutiveMediaGroups(parts, isMedia, [7, 6, 6])
    expect([...groups.entries()]).toEqual([[6, [6, 7]]])
  })

  it('ignores indexes outside the parts array', () => {
    const groups = consecutiveMediaGroups(parts, isMedia, [1, 2, 99])
    expect([...groups.entries()]).toEqual([[1, [1, 2]]])
  })

  it('returns no group when nothing is media', () => {
    expect(consecutiveMediaGroups([{ kind: 'text' }], isMedia).size).toBe(0)
  })
})
