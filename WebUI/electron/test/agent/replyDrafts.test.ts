import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { openReplyDraft, type ChannelDraft, type DraftEdit } from '../../agent/replyDrafts'

// Streamed replies as a Channel sees them: the edits each open draft makes, and how
// open drafts on one chat share its edit budget.

type Edit = { at: number; kind: ChannelKind; draft: ChannelDraft; text: string; replyTo?: string }

let edits: Edit[] = []
let start = 0
// Each test starts an hour on, so no chat still has budget spent by the one before.
let hours = 0

function recorder(outcome?: (draft: ChannelDraft) => { ref?: string; chat?: string }): DraftEdit {
  return async (kind, draft, text, replyTo) => {
    edits.push({ at: Date.now() - start, kind, draft: { ...draft }, text, replyTo })
    return { success: true, ...outcome?.(draft) }
  }
}

beforeEach(() => {
  vi.useFakeTimers({ now: Date.now() + 3_600_000 * ++hours })
  start = Date.now()
  edits = []
})

afterEach(() => {
  vi.useRealTimers()
})

describe('a reply draft', () => {
  it('shows its text at once, then its latest text, once per second on Telegram', async () => {
    const draft = openReplyDraft('telegram', { edit: recorder() })
    draft.update('Hel')
    draft.update('Hello')
    draft.update('Hello wor')
    await vi.advanceTimersByTimeAsync(0)
    draft.update('Hello world')
    await vi.advanceTimersByTimeAsync(2000)
    expect(edits.map(({ at, text }) => [at, text])).toEqual([
      [0, 'Hello wor'],
      [1000, 'Hello world'],
    ])
    await draft.close()
  })

  it('shares one edit budget per chat with the other open drafts, each keeping its own text', async () => {
    const first = openReplyDraft('telegram', { edit: recorder() })
    const second = openReplyDraft('telegram', { edit: recorder() })
    for (let tick = 1; tick <= 8; tick++) {
      first.update(`first ${tick}`)
      second.update(`second ${tick}`)
      await vi.advanceTimersByTimeAsync(500)
    }
    expect(edits.map((edit) => [edit.at, edit.text])).toEqual([
      [0, 'first 1'],
      [1000, 'second 2'],
      [2000, 'first 4'],
      [3000, 'second 6'],
      [4000, 'first 8'],
    ])
    const idOf = (name: string) => edits.find((edit) => edit.text.startsWith(name))!.draft.id
    expect(idOf('first')).not.toBe(idOf('second'))
    for (const edit of edits) expect(edit.draft.id).toBe(idOf(edit.text.split(' ')[0]))
    await first.close()
    await second.close()
  })

  it('leaves the budget of another Channel alone', async () => {
    const telegram = openReplyDraft('telegram', { edit: recorder() })
    const lan = openReplyDraft('local-web', { edit: recorder() })
    telegram.update('a')
    lan.update('b')
    await vi.advanceTimersByTimeAsync(0)
    expect(edits.map((edit) => [edit.at, edit.kind])).toEqual([
      [0, 'telegram'],
      [0, 'local-web'],
    ])
    await telegram.close()
    await lan.close()
  })

  it('posts a Slack message with its first edit, under the Answer, and edits that message after', async () => {
    const posted: string[] = []
    const draft = openReplyDraft('slack', {
      edit: recorder((open) => (open.ref ? {} : { ref: '1700.01', chat: 'D42' })),
      replyTo: '1700.00',
      onPosted: (ref) => posted.push(ref),
    })
    draft.update('one')
    await vi.advanceTimersByTimeAsync(0)
    draft.update('one two')
    await vi.advanceTimersByTimeAsync(1200)
    expect(edits.map(({ draft, text, replyTo }) => [draft.ref, draft.chat, text, replyTo])).toEqual(
      [
        [undefined, undefined, 'one', '1700.00'],
        ['1700.01', 'D42', 'one two', '1700.00'],
      ],
    )
    expect(posted).toEqual(['1700.01'])
    expect(await draft.close()).toMatchObject({ ref: '1700.01', chat: 'D42' })
  })

  it('settles nothing when it never showed any text', async () => {
    const draft = openReplyDraft('telegram', { edit: recorder() })
    expect(await draft.close()).toBeNull()
    expect(edits).toEqual([])
  })

  it('stops editing once closed, after the edit in flight has landed', async () => {
    let land: () => void = () => {}
    const draft = openReplyDraft('local-web', {
      edit: async (kind, open, text) => {
        edits.push({ at: Date.now() - start, kind, draft: open, text })
        await new Promise<void>((resolve) => (land = resolve))
        return { success: true }
      },
    })
    draft.update('partial')
    await vi.advanceTimersByTimeAsync(0)
    const closing = draft.close()
    draft.update('more')
    let closed: ChannelDraft | null | undefined
    void closing.then((result) => (closed = result))
    await vi.advanceTimersByTimeAsync(0)
    expect(closed).toBeUndefined()
    land()
    await vi.advanceTimersByTimeAsync(1000)
    expect(closed).toEqual({ id: edits[0].draft.id })
    expect(edits.map((edit) => edit.text)).toEqual(['partial'])
  })

  it('keeps a quiet Telegram draft from lapsing', async () => {
    const draft = openReplyDraft('telegram', { edit: recorder() })
    draft.update('thinking')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(edits.map((edit) => edit.text)).toEqual(['thinking', 'thinking ⠋', 'thinking ⠙'])
    const gaps = edits.slice(1).map((edit, index) => edit.at - edits[index].at)
    for (const gap of gaps) expect(gap).toBeLessThan(30_000)
    await draft.close()
  })
})
