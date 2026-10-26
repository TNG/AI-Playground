import { describe, expect, it } from 'vitest'
import {
  createAnswerRouter,
  type AnswerSendResult,
  type AnswerSessions,
  type HeldAnswerJournal,
  type HeldAnswerNote,
  type SessionPause,
  type SessionTurnEnd,
} from '../../../src/assets/js/store/channels/answerRouter'
import { createChannelQuestionRegistry } from '../../../src/assets/js/store/channels/channelQuestions'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type { ChannelKind } from '../../../src/assets/js/store/channels/types'

function fakeChannel(kind: ChannelKind = 'telegram') {
  const replies: string[] = []
  const adapter = {
    kind,
    formatMarkdown: (md: string) => md,
    formatRichSnippet: (html: string) => html,
    keyboard: async () => ({ success: true, ref: { messageId: 900 } }),
    editKeyboardMessage: async () => ({ success: true }),
    reply: async (text: string) => {
      replies.push(text)
      return { success: true }
    },
  } as unknown as ChannelAdapter
  return { adapter, replies }
}

type FakeSession = {
  label: string
  /** What each send does, in order; the last one repeats. */
  results?: AnswerSendResult[]
  result?: AnswerSendResult
  pause?: SessionPause
}

const BUSY: AnswerSendResult = { ok: false, reason: 'busy', message: 'turn in flight' }
const TASK_LOCKED: AnswerSendResult = {
  ok: false,
  reason: 'task-locked',
  message: 'Agent “Digest” is running.',
}

/** Agent sessions as the router sees them: which message each sent, and what a send does. */
function fakeSessions(
  sessions: Record<string, FakeSession>,
  sentMessages: { kind: ChannelKind; ref: string; sessionId: string }[],
) {
  const received: { sessionId: string; text: string }[] = []
  const held: Record<string, { text: string; channel: ChannelKind } | null> = {}
  const listeners = new Set<(sessionId: string, end: SessionTurnEnd) => void>()
  const port: AnswerSessions = {
    lookup: async (kind, ref) =>
      sentMessages.find((m) => m.kind === kind && m.ref === ref)?.sessionId ?? null,
    label: (sessionId) => `"${sessions[sessionId]?.label ?? 'An agent run'}"`,
    send: async (sessionId, text) => {
      received.push({ sessionId, text })
      const session = sessions[sessionId]
      const queued = session?.results
      if (queued && queued.length > 0) return queued.length > 1 ? queued.shift()! : queued[0]
      return session?.result ?? { ok: true, queuePosition: null }
    },
    pause: (sessionId) => sessions[sessionId]?.pause ?? null,
    held: (sessionId, answer) => {
      held[sessionId] = answer
    },
    onTurnEnd: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  /** The session's turn ended (or the desktop acted on it). */
  const end = async (sessionId: string, how: SessionTurnEnd) => {
    for (const listener of [...listeners]) listener(sessionId, how)
    await flush()
  }
  return { port, received, held, end }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** What survives an app close; the router itself does not. */
function memoryJournal() {
  let notes: HeldAnswerNote[] = []
  const journal: HeldAnswerJournal = {
    load: () => notes,
    save: (next) => {
      notes = JSON.parse(JSON.stringify(next))
    },
  }
  return journal
}

function setup(
  sessions: Record<string, FakeSession> = { asteroids: { label: 'Asteroids clone' } },
  sentMessages = [
    { kind: 'telegram' as ChannelKind, ref: '1234', sessionId: 'asteroids' },
    { kind: 'slack' as ChannelKind, ref: '1234', sessionId: 'asteroids' },
  ],
  journal: HeldAnswerJournal = memoryJournal(),
) {
  const questions = createChannelQuestionRegistry({ newId: () => 'q1', log: () => {} })
  const fake = fakeSessions(sessions, sentMessages)
  const router = createAnswerRouter({
    sessions: () => fake.port,
    questions,
    journal,
    log: () => {},
  })
  return { router, questions, ...fake, journal, sessions }
}

describe('answer router', () => {
  it('sends a reply to an agent’s Notification into its session and says it is starting', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { text: 'try a smaller level', replyTo: '1234' })).toBe(
      true,
    )
    expect(received).toEqual([{ sessionId: 'asteroids', text: 'try a smaller level' }])
    expect(ch.replies).toEqual(['➡️ Sent to "Asteroids clone" — starting…'])
  })

  it('says the Answer is queued, with its place, when the Turn Queue is busy', async () => {
    const { router } = setup({
      asteroids: { label: 'Asteroids clone', result: { ok: true, queuePosition: 2 } },
    })
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'again', replyTo: '1234' })
    expect(ch.replies).toEqual(['➡️ Sent to "Asteroids clone" — queued (position 2)'])
  })

  it('says why when the session refuses the Answer', async () => {
    const { router } = setup({
      asteroids: {
        label: 'Asteroids clone',
        result: { ok: false, reason: 'missing-folder', message: 'The workspace folder is missing' },
      },
    })
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { text: 'again', replyTo: '1234' })).toBe(true)
    expect(ch.replies).toEqual([
      '⚠️ Not sent to "Asteroids clone": The workspace folder is missing',
    ])
  })

  it('leaves a plain message to Home Agent', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { text: 'what is the weather?' })).toBe(false)
    expect(received).toEqual([])
    expect(ch.replies).toEqual([])
  })

  it('leaves a reply to a message no agent sent to Home Agent', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { text: 'and tomorrow?', replyTo: '77' })).toBe(false)
    expect(received).toEqual([])
  })

  it('finds the session by the channel the reply came on', async () => {
    const { router, received } = setup(
      { asteroids: { label: 'Asteroids clone' }, digest: { label: 'Daily digest' } },
      [
        { kind: 'telegram', ref: '5', sessionId: 'asteroids' },
        { kind: 'slack', ref: '5', sessionId: 'digest' },
      ],
    )
    const slack = fakeChannel('slack')
    await router.route(slack.adapter, { text: 'more sources', replyTo: '5' })
    expect(received).toEqual([{ sessionId: 'digest', text: 'more sources' }])
    expect(slack.replies).toEqual(['➡️ Sent to "Daily digest" — starting…'])
  })

  it('hands a button tap to its Channel Question, even on a reply', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { callback: 'confirm:gone:yes', replyTo: '1234' })).toBe(
      true,
    )
    expect(received).toEqual([])
    expect(ch.replies).toEqual([
      'This question is no longer open. Use AI Playground on your computer.',
    ])
  })

  it('never settles an open Home Agent confirmation with a typed Answer', async () => {
    const { router, questions, received } = setup()
    const ch = fakeChannel()
    const confirmation = questions.ask({
      adapter: ch.adapter,
      summaryMarkdown: 'Turn on Slack?',
      typedReply: true,
    })
    await flush()
    expect(await router.route(ch.adapter, { text: 'yes', replyTo: '1234' })).toBe(true)
    expect(received).toEqual([{ sessionId: 'asteroids', text: 'yes' }])
    expect(questions.isOpen(confirmation.id)).toBe(true)
  })

  it('settles an open Home Agent confirmation with a typed yes that is not an Answer', async () => {
    const { router, questions, received } = setup()
    const ch = fakeChannel()
    const confirmation = questions.ask({
      adapter: ch.adapter,
      summaryMarkdown: 'Turn on Slack?',
      typedReply: true,
    })
    await flush()
    expect(await router.route(ch.adapter, { text: 'yes' })).toBe(true)
    await expect(confirmation.answer).resolves.toBe(true)
    expect(received).toEqual([])
  })

  it('never settles an agent’s download question with a typed yes', async () => {
    const { router, questions } = setup()
    const ch = fakeChannel()
    const download = questions.ask({ adapter: ch.adapter, summaryMarkdown: 'Download Flux?' })
    await flush()
    expect(await router.route(ch.adapter, { text: 'yes' })).toBe(false)
    expect(questions.isOpen(download.id)).toBe(true)
  })
})

describe('a Held Answer', () => {
  function busy(extra: Partial<FakeSession> = {}) {
    return setup({
      asteroids: {
        label: 'Asteroids clone',
        results: [BUSY, { ok: true, queuePosition: null }],
        ...extra,
      },
    })
  }

  it('is held while the session is busy and confirmed as queued for the session', async () => {
    const { router, held } = busy()
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })).toBe(true)
    expect(ch.replies).toEqual([
      '⏳ Queued for "Asteroids clone" — it is sent when the current turn ends.',
    ])
    expect(held.asteroids).toEqual({ text: 'make it faster', channel: 'telegram' })
  })

  it('says it waits for the download buttons above while the turn is paused on a download', async () => {
    const { router, held } = busy({ pause: 'download' })
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'use the small one', replyTo: '1234' })
    expect(ch.replies).toEqual([
      '⏳ Queued for "Asteroids clone" — the session is waiting for the download buttons above.',
    ])
    expect(held.asteroids?.text).toBe('use the small one')
  })

  it('says it waits on the computer while the turn is paused on a confirmation', async () => {
    const { router, held } = busy({ pause: 'desktop' })
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'go ahead', replyTo: '1234' })
    expect(ch.replies).toEqual([
      '⏳ Queued for "Asteroids clone" — the session is waiting on your computer.',
    ])
    expect(held.asteroids?.text).toBe('go ahead')
  })

  it('is held while a Task run holds the session', async () => {
    const { router, held } = setup({
      asteroids: { label: 'Asteroids clone', results: [TASK_LOCKED] },
    })
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'add a summary', replyTo: '1234' })
    expect(ch.replies).toEqual([
      '⏳ Queued for "Asteroids clone" — it is sent when the current turn ends.',
    ])
    expect(held.asteroids?.text).toBe('add a summary')
  })

  it('is replaced by a newer Answer, and the channel is told', async () => {
    const { router, received, held, end } = busy()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    await router.route(ch.adapter, { text: 'no, make it slower', replyTo: '1234' })
    expect(ch.replies[1]).toBe(
      '⏳ Queued for "Asteroids clone" — it is sent when the current turn ends.\n' +
        'It replaces your earlier Answer, which will not be sent.',
    )
    expect(held.asteroids?.text).toBe('no, make it slower')
    await end('asteroids', 'completed')
    expect(received.slice(-1)).toEqual([{ sessionId: 'asteroids', text: 'no, make it slower' }])
    expect(received.filter((r) => r.text === 'make it faster')).toHaveLength(1)
  })

  it('tells the earlier Answer’s own channel when a newer one came on another', async () => {
    const { router } = busy()
    const telegram = fakeChannel('telegram')
    const slack = fakeChannel('slack')
    await router.route(telegram.adapter, { text: 'make it faster', replyTo: '1234' })
    await router.route(slack.adapter, { text: 'make it slower', replyTo: '1234' })
    expect(telegram.replies[1]).toBe(
      '⚠️ Not sent to "Asteroids clone": a newer Answer replaced it.',
    )
  })

  it('is sent when the turn completes', async () => {
    const { router, received, held, end } = busy()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    await end('asteroids', 'completed')
    expect(received).toEqual([
      { sessionId: 'asteroids', text: 'make it faster' },
      { sessionId: 'asteroids', text: 'make it faster' },
    ])
    expect(ch.replies.slice(1)).toEqual(['➡️ Sent to "Asteroids clone" — starting…'])
    expect(held.asteroids).toBeNull()
  })

  it('is sent anyway when the turn fails', async () => {
    const { router, received, end } = busy()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'what went wrong?', replyTo: '1234' })
    await end('asteroids', 'failed')
    expect(received.slice(-1)).toEqual([{ sessionId: 'asteroids', text: 'what went wrong?' }])
    expect(ch.replies.slice(1)).toEqual(['➡️ Sent to "Asteroids clone" — starting…'])
  })

  it('is dropped when the turn is stopped on the desktop, and the channel is told', async () => {
    const { router, received, held, end } = busy()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    await end('asteroids', 'stopped')
    expect(received).toHaveLength(1)
    expect(ch.replies.slice(1)).toEqual([
      '⚠️ Not sent to "Asteroids clone": the desktop took over.',
    ])
    expect(held.asteroids).toBeNull()
    await end('asteroids', 'completed')
    expect(received).toHaveLength(1)
  })

  it('is dropped when it is discarded on the desktop, and the channel is told', async () => {
    const { router, received, end } = busy()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    await end('asteroids', 'discarded')
    expect(received).toHaveLength(1)
    expect(ch.replies.slice(1)).toEqual([
      '⚠️ Not sent to "Asteroids clone": the desktop took over.',
    ])
  })

  it('is dropped when its session is deleted, and the channel is told it no longer exists', async () => {
    const { router, received, held, end } = busy()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    await end('asteroids', 'deleted')
    expect(received).toHaveLength(1)
    expect(ch.replies.slice(1)).toEqual([
      '⚠️ Not sent to "Asteroids clone": that session no longer exists.',
    ])
    expect(held.asteroids).toBeNull()
  })

  it('is only reported back on the channel it came from', async () => {
    const { router, end } = busy()
    const telegram = fakeChannel('telegram')
    const slack = fakeChannel('slack')
    await router.route(slack.adapter, { text: 'make it faster', replyTo: '1234' })
    await end('asteroids', 'completed')
    expect(telegram.replies).toEqual([])
    expect(slack.replies).toHaveLength(2)
  })
})

describe('a Held Answer for a Task run', () => {
  it('waits out every Step and is sent once the run’s last turn settles', async () => {
    const { router, received, end } = setup(
      {
        digest: {
          label: 'Digest — step 1 of 3',
          results: [TASK_LOCKED, TASK_LOCKED, TASK_LOCKED, { ok: true, queuePosition: null }],
        },
      },
      [{ kind: 'telegram', ref: '9', sessionId: 'digest' }],
    )
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'add sources', replyTo: '9' })
    await end('digest', 'completed')
    await end('digest', 'completed')
    expect(ch.replies).toHaveLength(1)
    await end('digest', 'completed')
    expect(received).toHaveLength(4)
    expect(ch.replies.slice(1)).toEqual(['➡️ Sent to "Digest — step 1 of 3" — starting…'])
  })

  it('continues a failed run’s session as an ordinary message', async () => {
    const { router, received, end } = setup(
      {
        digest: { label: 'Digest', results: [TASK_LOCKED, { ok: true, queuePosition: null }] },
      },
      [{ kind: 'telegram', ref: '9', sessionId: 'digest' }],
    )
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'try again with fewer sources', replyTo: '9' })
    await end('digest', 'failed')
    expect(received.slice(-1)).toEqual([
      { sessionId: 'digest', text: 'try again with fewer sources' },
    ])
  })
})

describe('a Held Answer lost to an app close', () => {
  it('is reported on its channel at the next start, once, and never sent', async () => {
    const journal = memoryJournal()
    const first = setup(
      { asteroids: { label: 'Asteroids clone', results: [BUSY] } },
      undefined,
      journal,
    )
    await first.router.route(fakeChannel().adapter, { text: 'make it faster', replyTo: '1234' })

    const next = setup({ asteroids: { label: 'Asteroids clone' } }, undefined, journal)
    const slack = fakeChannel('slack')
    await next.router.channelReady(slack.adapter)
    expect(slack.replies).toEqual([])
    const telegram = fakeChannel('telegram')
    await next.router.channelReady(telegram.adapter)
    await next.router.channelReady(telegram.adapter)
    expect(telegram.replies).toEqual([
      '⚠️ Not sent to "Asteroids clone": AI Playground closed before it could be sent.',
    ])
    await next.end('asteroids', 'completed')
    expect(next.received).toEqual([])

    const third = setup(undefined, undefined, journal)
    const again = fakeChannel('telegram')
    await third.router.channelReady(again.adapter)
    expect(again.replies).toEqual([])
  })

  it('is not reported once it was sent', async () => {
    const journal = memoryJournal()
    const first = setup(
      {
        asteroids: { label: 'Asteroids clone', results: [BUSY, { ok: true, queuePosition: null }] },
      },
      undefined,
      journal,
    )
    await first.router.route(fakeChannel().adapter, { text: 'make it faster', replyTo: '1234' })
    await first.end('asteroids', 'completed')

    const next = setup(undefined, undefined, journal)
    const telegram = fakeChannel('telegram')
    await next.router.channelReady(telegram.adapter)
    expect(telegram.replies).toEqual([])
  })
})
