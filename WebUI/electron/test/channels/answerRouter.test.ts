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
import type {
  ChannelKind,
  InboundMeta,
  RemoteAudio,
} from '../../../src/assets/js/store/channels/types'
import type { AgentAnswerOrigin } from '../../../src/types/agentIpc'

/** `replies` is everything the channel was told; `drafted` the part sent as a draft-settling reply. */
function fakeChannel(kind: ChannelKind = 'telegram') {
  const replies: string[] = []
  const drafted: string[] = []
  const metas: (InboundMeta | undefined)[] = []
  const adapter = {
    kind,
    formatMarkdown: (md: string) => md,
    formatRichSnippet: (html: string) => html,
    keyboard: async () => ({ success: true, ref: { messageId: 900 } }),
    editKeyboardMessage: async () => ({ success: true }),
    reply: async (text: string, meta?: InboundMeta) => {
      replies.push(text)
      drafted.push(text)
      metas.push(meta)
      return { success: true }
    },
    post: async (text: string, meta?: InboundMeta) => {
      replies.push(text)
      metas.push(meta)
      return { success: true }
    },
  } as unknown as ChannelAdapter
  return { adapter, replies, drafted, metas }
}

type FakeSession = {
  label: string
  /** What each send does, in order; the last one repeats. */
  results?: AnswerSendResult[]
  result?: AnswerSendResult
  pause?: SessionPause
  realShell?: boolean
  /** Runs while a send is in flight, before it resolves. */
  duringSend?: () => void
}

const BUSY: AnswerSendResult = { ok: false, reason: 'busy', message: 'turn in flight' }
const TASK_LOCKED: AnswerSendResult = {
  ok: false,
  reason: 'task-locked',
  message: 'Agent “Digest” is running.',
}

/** Agent sessions as the router sees them: which message each sent, and what a send does. */
type SentMessage = { kind: ChannelKind; ref: string; sessionId: string }

function fakeSessions(sessions: Record<string, FakeSession>, sentMessages: SentMessage[]) {
  const received: { sessionId: string; text: string }[] = []
  const origins: { sessionId: string; origin: AgentAnswerOrigin }[] = []
  const held: Record<string, { text: string; channel: ChannelKind } | null> = {}
  const listeners = new Set<(sessionId: string, end: SessionTurnEnd) => void>()
  const port: AnswerSessions = {
    lookup: async (kind, ref) => {
      const sent = sentMessages.find((m) => m.kind === kind && m.ref === ref)
      if (!sent) return null
      return sessions[sent.sessionId] ? { sessionId: sent.sessionId } : { deletedSession: true }
    },
    label: (sessionId) => `"${sessions[sessionId]?.label ?? 'An agent run'}"`,
    usesRealShell: (sessionId) => !!sessions[sessionId]?.realShell,
    send: async (sessionId, text, origin) => {
      received.push({ sessionId, text })
      origins.push({ sessionId, origin })
      const session = sessions[sessionId]
      session?.duringSend?.()
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
  return { port, received, origins, held, end }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** Home Agent's speech-to-text as the router sees it: voice data → what was said. */
function fakeTranscription() {
  const said: Record<string, string | null> = {}
  const transcribed: string[] = []
  const transcribe = async (_adapter: ChannelAdapter, audio: RemoteAudio[]) => {
    const words = audio.map((a) => said[a.data_base64])
    transcribed.push(...audio.map((a) => a.data_base64))
    return words.includes(null) ? null : words.join(' ')
  }
  return { said, transcribed, transcribe }
}

const voice = (data: string) => ({ audio: [{ mime: 'audio/ogg', data_base64: data }] })

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

/** The persisted "has seen how answering works" flag, shared across router instances (restarts). */
function fakeOnboardingFlag(seen = true) {
  const flag = { seen }
  return { seen: () => flag.seen, markSeen: () => (flag.seen = true) }
}

const ONBOARDING =
  '💡 Plain messages go to Home Agent. To talk to an agent, reply to its message (or tap 💬 Answer).'

function setup(
  sessions: Record<string, FakeSession> = { asteroids: { label: 'Asteroids clone' } },
  sentMessages: SentMessage[] = [
    { kind: 'telegram', ref: '1234', sessionId: 'asteroids' },
    { kind: 'slack', ref: '1234', sessionId: 'asteroids' },
  ],
  onboarding = fakeOnboardingFlag(),
  journal: HeldAnswerJournal = memoryJournal(),
) {
  const questions = createChannelQuestionRegistry({ newId: () => 'q1', log: () => {} })
  const fake = fakeSessions(sessions, sentMessages)
  const speech = fakeTranscription()
  // Where an agent's download question is asked: the Notification Channel, if any.
  const downloads = { askedOn: 'telegram' as ChannelKind | null }
  const router = createAnswerRouter({
    sessions: () => fake.port,
    questions,
    transcribe: speech.transcribe,
    downloadQuestionChannel: () => downloads.askedOn,
    journal,
    onboarding,
    log: () => {},
  })
  return { router, questions, ...fake, journal, sessions, speech, downloads }
}

describe('answer router', () => {
  it('sends a reply to an agent’s Notification into its session', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { text: 'try a smaller level', replyTo: '1234' })).toBe(
      true,
    )
    expect(received).toEqual([{ sessionId: 'asteroids', text: 'try a smaller level' }])
  })

  it.each(['telegram', 'local-web'] as const)(
    'posts no starting confirmation on %s, whose typing shows the Answer arrived',
    async (kind) => {
      const { router } = setup(undefined, [{ kind, ref: '1234', sessionId: 'asteroids' }])
      const ch = fakeChannel(kind)
      await router.route(ch.adapter, { text: 'try a smaller level', replyTo: '1234' })
      expect(ch.replies).toEqual([])
    },
  )

  it('says a Slack Answer is starting, since Slack shows no typing for it', async () => {
    const { router } = setup(undefined, [{ kind: 'slack', ref: '1234', sessionId: 'asteroids' }])
    const ch = fakeChannel('slack')
    await router.route(ch.adapter, { text: 'try a smaller level', replyTo: '1234' })
    expect(ch.replies).toEqual(['➡️ Sent to "Asteroids clone" — starting…'])
  })

  it('tells the session where the Answer came from, so its result is replied under it', async () => {
    const { router, origins } = setup()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'again', replyTo: '1234', replyTarget: '1300' })
    expect(origins).toEqual([
      { sessionId: 'asteroids', origin: { channel: 'telegram', replyTo: '1300' } },
    ])
  })

  it('confirms with a message of its own, never taking over a streaming Home Agent draft', async () => {
    const { router } = setup(
      { asteroids: { label: 'Asteroids clone', result: { ok: true, queuePosition: 2 } } },
      [{ kind: 'local-web', ref: '1234', sessionId: 'asteroids' }],
    )
    const ch = fakeChannel('local-web')
    await router.route(ch.adapter, { text: 'try a smaller level', replyTo: '1234' })
    expect(ch.replies).toEqual(['➡️ Sent to "Asteroids clone" — queued (position 2)'])
    expect(ch.drafted).toEqual([])
  })

  it('confirms a Slack Answer in the thread it was given in', async () => {
    const { router } = setup(undefined, [
      { kind: 'slack', ref: '1700000000.0001', sessionId: 'asteroids' },
    ])
    const ch = fakeChannel('slack')
    await router.route(
      ch.adapter,
      { text: 'try a smaller level', replyTo: '1700000000.0001', replyTarget: '1700000000.0001' },
      { channel: 'C1', ts: '1700000000.0005' },
    )
    expect(ch.metas).toEqual([
      { channel: 'C1', ts: '1700000000.0005', threadTs: '1700000000.0001' },
    ])
  })

  it('takes a Slack thread reply under a Notification as its Answer, replied in that thread', async () => {
    const { router, received, origins } = setup(undefined, [
      { kind: 'slack', ref: '1700000000.0001', sessionId: 'asteroids' },
    ])
    const ch = fakeChannel('slack')
    const threadReply = {
      text: 'try a smaller level',
      replyTo: '1700000000.0001',
      replyTarget: '1700000000.0001',
    }
    expect(await router.route(ch.adapter, threadReply)).toBe(true)
    expect(received).toEqual([{ sessionId: 'asteroids', text: 'try a smaller level' }])
    expect(origins).toEqual([
      { sessionId: 'asteroids', origin: { channel: 'slack', replyTo: '1700000000.0001' } },
    ])
  })

  it('leaves a Slack thread reply under a message no agent sent to Home Agent', async () => {
    const { router, received } = setup(undefined, [])
    const ch = fakeChannel('slack')
    const threadReply = {
      text: 'thanks',
      replyTo: '1700000000.0009',
      replyTarget: '1700000000.0009',
    }
    expect(await router.route(ch.adapter, threadReply)).toBe(false)
    expect(received).toEqual([])
  })

  it.each(['telegram', 'slack', 'local-web'] as const)(
    'says the Answer is queued on %s, with its place, when the Turn Queue is busy',
    async (kind) => {
      const { router } = setup(
        { asteroids: { label: 'Asteroids clone', result: { ok: true, queuePosition: 2 } } },
        [{ kind, ref: '1234', sessionId: 'asteroids' }],
      )
      const ch = fakeChannel(kind)
      await router.route(ch.adapter, { text: 'again', replyTo: '1234' })
      expect(ch.replies).toEqual(['➡️ Sent to "Asteroids clone" — queued (position 2)'])
    },
  )

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

  it('leaves a tap on an Answer button to Home Agent, opening no Answer Prompt', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { callback: 'answer', replyTo: '1234' })).toBe(false)
    expect(received).toEqual([])
    expect(ch.replies).toEqual([])
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

  describe('an Answer that cannot be delivered', () => {
    it('says a deleted session no longer exists', async () => {
      const { router, received } = setup({}, [
        { kind: 'telegram', ref: '1234', sessionId: 'deleted' },
      ])
      const ch = fakeChannel()
      expect(await router.route(ch.adapter, { text: 'again', replyTo: '1234' })).toBe(true)
      expect(received).toEqual([])
      expect(ch.replies).toEqual(['⚠️ That session no longer exists'])
    })

    it('says the session no longer exists when it went away before the send', async () => {
      const { router } = setup({
        asteroids: {
          label: 'Asteroids clone',
          result: { ok: false, reason: 'no-session', message: 'No agent session asteroids.' },
        },
      })
      const ch = fakeChannel()
      await router.route(ch.adapter, { text: 'again', replyTo: '1234' })
      expect(ch.replies).toEqual(['⚠️ That session no longer exists'])
    })

    it('asks for an Answer to a real-shell session on the computer, and sends nothing', async () => {
      const { router, received } = setup({
        asteroids: { label: 'Asteroids clone', realShell: true },
      })
      const ch = fakeChannel()
      expect(await router.route(ch.adapter, { text: 'rm -rf build', replyTo: '1234' })).toBe(true)
      expect(received).toEqual([])
      expect(ch.replies).toEqual([
        '🖥️ "Asteroids clone" uses the real system shell. Answer on your computer.',
      ])
    })

    it.each([
      ['missing-folder', 'The workspace folder is missing: /games/asteroids'],
      ['settings-problems', 'The selected model is not installed.'],
    ])('gives the reason for a %s refusal and where to fix it', async (reason, message) => {
      const { router } = setup({
        asteroids: { label: 'Asteroids clone', result: { ok: false, reason, message } },
      })
      const ch = fakeChannel()
      expect(await router.route(ch.adapter, { text: 'again', replyTo: '1234' })).toBe(true)
      expect(ch.replies).toEqual([
        `⚠️ Not sent to "Asteroids clone": ${message}\n` +
          'Fix it in AI Playground on your computer, then answer again.',
      ])
    })

    it.each([
      ['photo', { text: '[image]', images: [{ mime: 'image/jpeg', data_base64: 'AAAA' }] }],
      [
        'document',
        {
          text: 'the level data',
          documents: [{ filename: 'level.txt', mime: 'text/plain', data_base64: 'AAAA' }],
        },
      ],
      [
        'file the channel refused to read',
        { text: 'the level data', refused: 'Unsupported document type.' },
      ],
    ])('refuses a %s sent as an Answer and sends nothing', async (_kind, attachment) => {
      const { router, received } = setup()
      const ch = fakeChannel()
      expect(await router.route(ch.adapter, { ...attachment, replyTo: '1234' })).toBe(true)
      expect(received).toEqual([])
      expect(ch.replies).toEqual(['⚠️ Answers to agents can only be text for now'])
    })

    it('leaves a photo that answers no agent to Home Agent', async () => {
      const { router } = setup()
      const ch = fakeChannel()
      const photo = { text: '[image]', images: [{ mime: 'image/jpeg', data_base64: 'AAAA' }] }
      expect(await router.route(ch.adapter, { ...photo, replyTo: '77' })).toBe(false)
      expect(ch.replies).toEqual([])
    })
  })

  describe('a voice Answer', () => {
    it('is transcribed and sent to the session as text', async () => {
      const { router, received, speech } = setup()
      speech.said['ogg-1'] = 'try a smaller level'
      const ch = fakeChannel()
      expect(await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })).toBe(true)
      expect(received).toEqual([{ sessionId: 'asteroids', text: 'try a smaller level' }])
      expect(ch.replies).toEqual([])
    })

    it('sends nothing when transcription failed, leaving the explanation to it', async () => {
      const { router, received, speech } = setup()
      speech.said['ogg-1'] = null
      const ch = fakeChannel()
      expect(await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })).toBe(true)
      expect(received).toEqual([])
      expect(ch.replies).toEqual([])
    })

    it('says so when no speech was heard, and sends nothing', async () => {
      const { router, received, speech } = setup()
      speech.said['ogg-1'] = ''
      const ch = fakeChannel()
      expect(await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })).toBe(true)
      expect(received).toEqual([])
      expect(ch.replies).toEqual([
        "🎙️ Couldn't make out any speech in that voice message, so nothing was sent.",
      ])
    })

    it('is not transcribed here when it answers no agent', async () => {
      const { router, speech } = setup()
      const ch = fakeChannel()
      expect(await router.route(ch.adapter, voice('ogg-1'))).toBe(false)
      expect(speech.transcribed).toEqual([])
    })

    it('is not transcribed for a session that no longer exists', async () => {
      const { router, speech } = setup({}, [{ kind: 'telegram', ref: '1234', sessionId: 'gone' }])
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      expect(speech.transcribed).toEqual([])
      expect(ch.replies).toEqual(['⚠️ That session no longer exists'])
    })
  })

  it('explains how answering works after the very first Answer, and never again', async () => {
    const flag = fakeOnboardingFlag(false)
    const first = setup(undefined, undefined, flag)
    const ch = fakeChannel()
    await first.router.route(ch.adapter, { text: 'try a smaller level', replyTo: '1234' })
    await first.router.route(ch.adapter, { text: 'and faster', replyTo: '1234' })
    const afterRestart = setup(undefined, undefined, flag)
    await afterRestart.router.route(ch.adapter, { text: 'once more', replyTo: '1234' })
    expect(ch.replies).toEqual([ONBOARDING])
  })

  it('does not explain answering to a plain message for Home Agent', async () => {
    const { router } = setup(undefined, undefined, fakeOnboardingFlag(false))
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'what is the weather?' })
    expect(ch.replies).toEqual([])
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

  it('says the download is asked on the other channel when the Answer came elsewhere', async () => {
    const { router, downloads } = busy({ pause: 'download' })
    downloads.askedOn = 'slack'
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'use the small one', replyTo: '1234' })
    expect(ch.replies).toEqual([
      '⏳ Queued for "Asteroids clone" — the session is waiting for the download buttons in ' +
        'your notifications chat, or on your computer.',
    ])
  })

  it('says the download waits on the computer when no channel asks it', async () => {
    const { router, downloads } = busy({ pause: 'download' })
    downloads.askedOn = null
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'use the small one', replyTo: '1234' })
    expect(ch.replies).toEqual([
      '⏳ Queued for "Asteroids clone" — the session is waiting on your computer.',
    ])
  })

  it('is sent at once when the turn ended while its first send was being refused', async () => {
    let fired = false
    const fixture = setup({
      asteroids: {
        label: 'Asteroids clone',
        results: [BUSY, { ok: true, queuePosition: null }],
        duringSend: () => {
          if (fired) return
          fired = true
          void fixture.end('asteroids', 'completed')
        },
      },
    })
    const ch = fakeChannel()
    await fixture.router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    await flush()
    expect(fixture.received).toHaveLength(2)
    expect(ch.replies).toEqual([])
    expect(fixture.held.asteroids ?? null).toBeNull()
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
    expect(ch.replies.slice(1)).toEqual([])
    expect(held.asteroids).toBeNull()
  })

  it('is said to be starting on Slack when the turn completes and it is sent', async () => {
    const { router, end } = busy()
    const ch = fakeChannel('slack')
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    await end('asteroids', 'completed')
    expect(ch.replies).toEqual([
      '⏳ Queued for "Asteroids clone" — it is sent when the current turn ends.',
      '➡️ Sent to "Asteroids clone" — starting…',
    ])
  })

  it('is sent with where it came from, so its turn replies under it', async () => {
    const { router, origins, end } = busy()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234', replyTarget: '1300' })
    await end('asteroids', 'completed')
    expect(origins.slice(-1)).toEqual([
      { sessionId: 'asteroids', origin: { channel: 'telegram', replyTo: '1300' } },
    ])
  })

  it('is sent anyway when the turn fails', async () => {
    const { router, received, end } = busy()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'what went wrong?', replyTo: '1234' })
    await end('asteroids', 'failed')
    expect(received.slice(-1)).toEqual([{ sessionId: 'asteroids', text: 'what went wrong?' }])
    expect(ch.replies.slice(1)).toEqual([])
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
    expect(ch.replies.slice(1)).toEqual([])
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
      undefined,
      journal,
    )
    await first.router.route(fakeChannel().adapter, { text: 'make it faster', replyTo: '1234' })

    const next = setup({ asteroids: { label: 'Asteroids clone' } }, undefined, undefined, journal)
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

    const third = setup(undefined, undefined, undefined, journal)
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
      undefined,
      journal,
    )
    await first.router.route(fakeChannel().adapter, { text: 'make it faster', replyTo: '1234' })
    await first.end('asteroids', 'completed')

    const next = setup(undefined, undefined, undefined, journal)
    const telegram = fakeChannel('telegram')
    await next.router.channelReady(telegram.adapter)
    expect(telegram.replies).toEqual([])
  })
})
