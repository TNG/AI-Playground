import { describe, expect, it } from 'vitest'
import {
  createAnswerRouter,
  type SessionSendResult,
  type SessionPort,
  type HeldAnswerJournal,
  type HeldAnswerNote,
  type SessionPause,
  type SessionTurnEnd,
  type VoiceAnswerPreparation,
  type ChannelSessionPointers,
  type ChannelTranscriptMessage,
} from '../../../src/assets/js/store/channels/answerRouter'
import { createChannelQuestionRegistry } from '../../../src/assets/js/store/channels/channelQuestions'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type {
  ChannelKind,
  InboundMeta,
  KeyboardButton,
  RemoteAudio,
} from '../../../src/assets/js/store/channels/types'
import type { AgentAnswerOrigin } from '../../../src/types/agentIpc'

/** `replies` is everything the channel was told; `drafted` the part sent as a draft-settling reply. */
function fakeChannel(kind: ChannelKind = 'telegram') {
  const replies: string[] = []
  const drafted: string[] = []
  const metas: (InboundMeta | undefined)[] = []
  const keyboards: { text: string; buttons: KeyboardButton[][] }[] = []
  const repaints: { role: string; text: string }[][] = []
  const adapter = {
    kind,
    formatMarkdown: (md: string) => md,
    formatRichSnippet: (html: string) => html,
    formatFinal: (parts: { text?: string }[]) => parts.map((p) => p.text ?? '').join(''),
    keyboard: async (text: string, buttons: KeyboardButton[][]) => {
      keyboards.push({ text, buttons })
      return { success: true, ref: { messageId: 900 } }
    },
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
    // Only LAN chat keeps no history of its own, so only it is repainted.
    ...(kind === 'local-web'
      ? {
          replayHistory: async (messages: { role: string; text: string }[]) => {
            repaints.push(messages.map(({ role, text }) => ({ role, text })))
            return { success: true }
          },
        }
      : {}),
  } as unknown as ChannelAdapter
  return { adapter, replies, drafted, metas, keyboards, repaints }
}

type FakeSession = {
  label: string
  /** What each send does, in order; the last one repeats. */
  results?: SessionSendResult[]
  result?: SessionSendResult
  pause?: SessionPause
  realShell?: boolean
  /** Reachable from Channels unless false. */
  reachable?: boolean
  /** The Session was deleted, though the message map still names it. */
  gone?: boolean
  /** Runs while a send is in flight, before it resolves. */
  duringSend?: () => void
}

const BUSY: SessionSendResult = { ok: false, reason: 'busy', message: 'turn in flight' }
const TASK_LOCKED: SessionSendResult = {
  ok: false,
  reason: 'task-locked',
  message: 'Agent “Digest” is running.',
}

/** Harness Sessions as the router sees them: which message each sent, and what a send does. */
type SentMessage = { kind: ChannelKind; ref: string; sessionId: string }

/** The Session each fake Harness Session belongs to. */
const sessionRefOf = (harnessSessionId: string) => `session-of-${harnessSessionId}`

/** A Session a Channel can pick as its Channel Session, keyed by its ref. */
type FakeChannelSession = {
  title: string
  reachable?: boolean
  gone?: boolean
  result?: SessionSendResult
  transcript?: ChannelTranscriptMessage[]
}

function fakeSessions(
  sessions: Record<string, FakeSession>,
  sentMessages: SentMessage[],
  channelSessions: Record<string, FakeChannelSession>,
) {
  const received: { sessionId: string; text: string }[] = []
  /** Plain messages, sent to a Session's Assistant rather than a Harness Session. */
  const plain: { sessionRef: string; text: string; origin: AgentAnswerOrigin }[] = []
  const created: string[] = []
  const creation = { fails: false }
  const origins: { sessionId: string; origin: AgentAnswerOrigin }[] = []
  const held: Record<string, { text: string; channel: ChannelKind } | null> = {}
  const listeners = new Set<(sessionId: string, end: SessionTurnEnd) => void>()
  const harnessOf = (sessionRef: string) =>
    Object.entries(sessions).find(([id]) => sessionRefOf(id) === sessionRef)?.[1]
  const reachable = (session: { gone?: boolean; reachable?: boolean } | undefined) =>
    !!session && !session.gone && session.reachable !== false
  const port: SessionPort = {
    exists: async (sessionRef) => {
      const session = harnessOf(sessionRef) ?? channelSessions[sessionRef]
      return !!session && !session.gone
    },
    isReachable: async (sessionRef) =>
      reachable(harnessOf(sessionRef) ?? channelSessions[sessionRef]),
    listReachable: async () =>
      Object.entries(channelSessions)
        .filter(([, session]) => reachable(session))
        .map(([sessionRef, session]) => ({ sessionRef, title: session.title })),
    create: async () => {
      if (creation.fails) throw new Error('disk full')
      const sessionRef = `session-new-${created.length + 1}`
      created.push(sessionRef)
      channelSessions[sessionRef] = { title: '' }
      return sessionRef
    },
    transcript: async (sessionRef) => channelSessions[sessionRef]?.transcript ?? [],
    lookup: async (kind, ref) => {
      const sent = sentMessages.find((m) => m.kind === kind && m.ref === ref)
      if (!sent) return null
      const harnessSessionId = sent.sessionId
      return sessions[harnessSessionId]
        ? { sessionRef: sessionRefOf(harnessSessionId), harnessSessionId }
        : { deletedSession: true }
    },
    label: (target) =>
      'harnessSessionId' in target
        ? `"${sessions[target.harnessSessionId]?.label ?? 'An agent run'}"`
        : `"${channelSessions[target.sessionRef]?.title || 'Untitled Session'}"`,
    usesRealShell: ({ harnessSessionId }) => !!sessions[harnessSessionId]?.realShell,
    send: async (target, text, origin) => {
      if (!('harnessSessionId' in target)) {
        plain.push({ sessionRef: target.sessionRef, text, origin })
        return channelSessions[target.sessionRef]?.result ?? { ok: true, queuePosition: null }
      }
      const { sessionRef, harnessSessionId: sessionId } = target
      if (sessionRef !== sessionRefOf(sessionId)) {
        return { ok: false, reason: 'wrong-session', message: `${sessionRef} ≠ ${sessionId}` }
      }
      received.push({ sessionId, text })
      origins.push({ sessionId, origin })
      const session = sessions[sessionId]
      session?.duringSend?.()
      const queued = session?.results
      if (queued && queued.length > 0) return queued.length > 1 ? queued.shift()! : queued[0]
      return session?.result ?? { ok: true, queuePosition: null }
    },
    pause: ({ harnessSessionId }) => sessions[harnessSessionId]?.pause ?? null,
    held: ({ harnessSessionId }, answer) => {
      held[harnessSessionId] = answer
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
  return { port, received, origins, held, end, plain, created, creation }
}

/** Each Channel's Channel Session, as the Channels store keeps it. */
function memoryPointers(initial: Partial<Record<ChannelKind, string>> = {}) {
  const current: Partial<Record<ChannelKind, string>> = { ...initial }
  const pointers: ChannelSessionPointers = {
    get: (kind) => current[kind] ?? null,
    set: (kind, sessionRef) => {
      if (sessionRef) current[kind] = sessionRef
      else delete current[kind]
    },
  }
  return { pointers, current }
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

/** Readying speech-to-text for a voice Answer: a download waits until the test lets it through. */
function fakeVoicePreparation() {
  const waiting: { sessionId: string; finish: (ready: boolean) => void }[] = []
  let gated = false
  const prepare = async (
    _adapter: ChannelAdapter,
    sessionId: string,
  ): Promise<VoiceAnswerPreparation> =>
    gated
      ? { downloading: new Promise<boolean>((finish) => waiting.push({ sessionId, finish })) }
      : { ready: true }
  return {
    waiting,
    prepare,
    /** Every following voice Answer waits, as for a speech model download. */
    needDownload: () => {
      gated = true
    },
  }
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

function setup(
  sessions: Record<string, FakeSession> = { asteroids: { label: 'Asteroids clone' } },
  sentMessages: SentMessage[] = [
    { kind: 'telegram', ref: '1234', sessionId: 'asteroids' },
    { kind: 'slack', ref: '1234', sessionId: 'asteroids' },
  ],
  journal: HeldAnswerJournal = memoryJournal(),
  channelSessions: Record<string, FakeChannelSession> = {},
  initialPointers: Partial<Record<ChannelKind, string>> = {},
) {
  const questions = createChannelQuestionRegistry({ newId: () => 'q1', log: () => {} })
  const fake = fakeSessions(sessions, sentMessages, channelSessions)
  const channelPointers = memoryPointers(initialPointers)
  const speech = fakeTranscription()
  const voicePreparation = fakeVoicePreparation()
  // Where an agent's download question is asked: every enabled Channel.
  const downloads = { askedOn: ['telegram'] as ChannelKind[] }
  const router = createAnswerRouter({
    sessions: () => fake.port,
    questions,
    transcribe: speech.transcribe,
    prepareVoiceAnswer: voicePreparation.prepare,
    downloadQuestionChannels: () => downloads.askedOn,
    journal,
    pointers: channelPointers.pointers,
    log: () => {},
  })
  return {
    router,
    questions,
    ...fake,
    journal,
    sessions,
    speech,
    voicePreparation,
    downloads,
    pointers: channelPointers.current,
  }
}

describe('answer router', () => {
  it('sends a reply to an agent’s Notification into its session', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'try a smaller level', replyTo: '1234' })
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
    await router.route(ch.adapter, threadReply)
    expect(received).toEqual([{ sessionId: 'asteroids', text: 'try a smaller level' }])
    expect(origins).toEqual([
      { sessionId: 'asteroids', origin: { channel: 'slack', replyTo: '1700000000.0001' } },
    ])
  })

  it('sends a Slack thread reply under a message no agent sent to the Channel Session', async () => {
    const { router, received, plain } = setup(
      undefined,
      [],
      undefined,
      {
        'session-home': { title: 'Home' },
      },
      { slack: 'session-home' },
    )
    const ch = fakeChannel('slack')
    const threadReply = {
      text: 'thanks',
      replyTo: '1700000000.0009',
      replyTarget: '1700000000.0009',
    }
    await router.route(ch.adapter, threadReply)
    expect(received).toEqual([])
    expect(plain.map((p) => p.sessionRef)).toEqual(['session-home'])
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

  it('sends a reply to a message no agent sent to the Channel Session, as a plain message', async () => {
    const { router, received, plain } = setup(
      undefined,
      undefined,
      undefined,
      { 'session-home': { title: 'Home' } },
      { telegram: 'session-home' },
    )
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'and tomorrow?', replyTo: '77' })
    expect(received).toEqual([])
    expect(plain.map((p) => p.text)).toEqual(['and tomorrow?'])
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

  it('ignores a tap on an Answer button, which only opens the reply on the platform', async () => {
    const { router, received, plain } = setup()
    const ch = fakeChannel()
    await router.route(ch.adapter, { callback: 'answer', replyTo: '1234' })
    expect(received).toEqual([])
    expect(plain).toEqual([])
    expect(ch.replies).toEqual([])
  })

  it('hands a button tap to its Channel Question, even on a reply', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    await router.route(ch.adapter, { callback: 'confirm:gone:yes', replyTo: '1234' })
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
    await router.route(ch.adapter, { text: 'yes', replyTo: '1234' })
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
    await router.route(ch.adapter, { text: 'yes' })
    await expect(confirmation.answer).resolves.toBe(true)
    expect(received).toEqual([])
  })

  it('never settles an agent’s download question with a typed yes', async () => {
    const { router, questions } = setup()
    const ch = fakeChannel()
    const download = questions.ask({ adapter: ch.adapter, summaryMarkdown: 'Download Flux?' })
    await flush()
    await router.route(ch.adapter, { text: 'yes' })
    expect(questions.isOpen(download.id)).toBe(true)
  })

  describe('an Answer that cannot be delivered', () => {
    it('says a deleted Session was deleted', async () => {
      const { router, received } = setup({}, [
        { kind: 'telegram', ref: '1234', sessionId: 'deleted' },
      ])
      const ch = fakeChannel()
      await router.route(ch.adapter, { text: 'again', replyTo: '1234' })
      expect(received).toEqual([])
      expect(ch.replies).toEqual(['⚠️ That Session was deleted'])
    })

    it('says the Session was deleted when the message still names it but it is gone', async () => {
      const { router, received } = setup({ asteroids: { label: 'Asteroids clone', gone: true } })
      const ch = fakeChannel()
      await router.route(ch.adapter, { text: 'again', replyTo: '1234' })
      expect(received).toEqual([])
      expect(ch.replies).toEqual(['⚠️ That Session was deleted'])
    })

    it('refuses an Answer to a Session that is no longer reachable, and sends nothing', async () => {
      const { router, received } = setup({
        asteroids: { label: 'Asteroids clone', reachable: false },
      })
      const ch = fakeChannel()
      await router.route(ch.adapter, { text: 'again', replyTo: '1234' })
      expect(received).toEqual([])
      expect(ch.replies).toEqual([
        '🔒 "Asteroids clone" is not reachable from Channels. ' +
          'Turn on "Reachable from Channels" in its menu on your computer to answer it.',
      ])
    })

    it('does not transcribe a voice Answer to a Session that is not reachable', async () => {
      const { router, speech, received } = setup({
        asteroids: { label: 'Asteroids clone', reachable: false },
      })
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      expect(speech.transcribed).toEqual([])
      expect(received).toEqual([])
    })

    it('says the Session was deleted when it went away before the send', async () => {
      const { router } = setup({
        asteroids: {
          label: 'Asteroids clone',
          result: { ok: false, reason: 'no-session', message: 'No agent session asteroids.' },
        },
      })
      const ch = fakeChannel()
      await router.route(ch.adapter, { text: 'again', replyTo: '1234' })
      expect(ch.replies).toEqual(['⚠️ That Session was deleted'])
    })

    it('asks for an Answer to a real-shell session on the computer, and sends nothing', async () => {
      const { router, received } = setup({
        asteroids: { label: 'Asteroids clone', realShell: true },
      })
      const ch = fakeChannel()
      await router.route(ch.adapter, { text: 'rm -rf build', replyTo: '1234' })
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
      await router.route(ch.adapter, { text: 'again', replyTo: '1234' })
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
      await router.route(ch.adapter, { ...attachment, replyTo: '1234' })
      expect(received).toEqual([])
      expect(ch.replies).toEqual(['⚠️ Answers to agents can only be text for now'])
    })

    it('treats a photo that answers no agent as a plain message', async () => {
      const { router, plain } = setup()
      const ch = fakeChannel()
      const photo = { text: '[image]', images: [{ mime: 'image/jpeg', data_base64: 'AAAA' }] }
      await router.route(ch.adapter, { ...photo, replyTo: '77' })
      expect(plain).toEqual([])
      expect(ch.replies).toEqual([
        "⚠️ Images, documents and voice messages can't be sent to a Session yet. Send text instead.",
      ])
    })
  })

  describe('a voice Answer', () => {
    it('is transcribed and sent to the session as text', async () => {
      const { router, received, speech } = setup()
      speech.said['ogg-1'] = 'try a smaller level'
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      expect(received).toEqual([{ sessionId: 'asteroids', text: 'try a smaller level' }])
      expect(ch.replies).toEqual([])
    })

    it('does not hold up the next channel message while its speech model downloads', async () => {
      const { router, received, speech, voicePreparation } = setup(
        { asteroids: { label: 'Asteroids clone' }, digest: { label: 'Digest' } },
        [
          { kind: 'telegram', ref: '1234', sessionId: 'asteroids' },
          { kind: 'telegram', ref: '5678', sessionId: 'digest' },
        ],
      )
      speech.said['ogg-1'] = 'try a smaller level'
      voicePreparation.needDownload()
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      await router.route(ch.adapter, { text: 'skip sports', replyTo: '5678' })
      expect(received).toEqual([{ sessionId: 'digest', text: 'skip sports' }])
      expect(voicePreparation.waiting.map((w) => w.sessionId)).toEqual(['asteroids'])
    })

    it('is delivered to its session once the download finished', async () => {
      const { router, received, speech, voicePreparation } = setup()
      speech.said['ogg-1'] = 'try a smaller level'
      voicePreparation.needDownload()
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      expect(speech.transcribed).toEqual([])
      voicePreparation.waiting[0].finish(true)
      await flush()
      expect(received).toEqual([{ sessionId: 'asteroids', text: 'try a smaller level' }])
    })

    it('is held after the download when the session is busy by then', async () => {
      const { router, received, held, speech, voicePreparation } = setup({
        asteroids: { label: 'Asteroids clone', results: [BUSY] },
      })
      speech.said['ogg-1'] = 'try a smaller level'
      voicePreparation.needDownload()
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      voicePreparation.waiting[0].finish(true)
      await flush()
      expect(received).toHaveLength(1)
      expect(held.asteroids).toEqual({ text: 'try a smaller level', channel: 'telegram' })
    })

    it('is dropped unheard when its speech model was not readied', async () => {
      const { router, received, speech, voicePreparation } = setup()
      speech.said['ogg-1'] = 'try a smaller level'
      voicePreparation.needDownload()
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      voicePreparation.waiting[0].finish(false)
      await flush()
      expect(speech.transcribed).toEqual([])
      expect(received).toEqual([])
    })

    it('is sent before the next channel message is read when no download is needed', async () => {
      const { router, received, speech } = setup()
      speech.said['ogg-1'] = 'try a smaller level'
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      await router.route(ch.adapter, { text: 'and add a boss', replyTo: '1234' })
      expect(received).toEqual([
        { sessionId: 'asteroids', text: 'try a smaller level' },
        { sessionId: 'asteroids', text: 'and add a boss' },
      ])
    })

    it('keeps later Answers to its session behind it while its speech model downloads', async () => {
      const { router, received, speech, voicePreparation } = setup()
      speech.said['ogg-1'] = 'try a smaller level'
      speech.said['ogg-2'] = 'with more lives'
      voicePreparation.needDownload()
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      await router.route(ch.adapter, { text: 'and add a boss', replyTo: '1234' })
      await router.route(ch.adapter, { ...voice('ogg-2'), replyTo: '1234' })
      await flush()
      expect(received).toEqual([])
      voicePreparation.waiting[0].finish(true)
      await flush()
      voicePreparation.waiting[1].finish(true)
      await flush()
      expect(received.map((r) => r.text)).toEqual([
        'try a smaller level',
        'and add a boss',
        'with more lives',
      ])
    })

    it('sends nothing when transcription failed, leaving the explanation to it', async () => {
      const { router, received, speech } = setup()
      speech.said['ogg-1'] = null
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      expect(received).toEqual([])
      expect(ch.replies).toEqual([])
    })

    it('says so when no speech was heard, and sends nothing', async () => {
      const { router, received, speech } = setup()
      speech.said['ogg-1'] = ''
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      expect(received).toEqual([])
      expect(ch.replies).toEqual([
        "🎙️ Couldn't make out any speech in that voice message, so nothing was sent.",
      ])
    })

    it('is not transcribed here when it answers no agent', async () => {
      const { router, speech, plain } = setup()
      const ch = fakeChannel()
      await router.route(ch.adapter, voice('ogg-1'))
      expect(speech.transcribed).toEqual([])
      expect(plain).toEqual([])
    })

    it('is not transcribed for a session that no longer exists', async () => {
      const { router, speech } = setup({}, [{ kind: 'telegram', ref: '1234', sessionId: 'gone' }])
      const ch = fakeChannel()
      await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
      expect(speech.transcribed).toEqual([])
      expect(ch.replies).toEqual(['⚠️ That Session was deleted'])
    })
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
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
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
    downloads.askedOn = ['slack']
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'use the small one', replyTo: '1234' })
    expect(ch.replies).toEqual([
      '⏳ Queued for "Asteroids clone" — the session is waiting for the download buttons in ' +
        'your notifications chat, or on your computer.',
    ])
  })

  it('says the download waits on the computer when no channel asks it', async () => {
    const { router, downloads } = busy({ pause: 'download' })
    downloads.askedOn = []
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

/** A router whose Channels reach these Sessions, newest first, with these Channel Sessions. */
function channelSetup(
  channelSessions: Record<string, FakeChannelSession> = {},
  pointers: Partial<Record<ChannelKind, string>> = {},
) {
  return setup(undefined, undefined, undefined, channelSessions, pointers)
}

describe('a plain message', () => {
  it('runs in the Channel Session, its reply threaded under it', async () => {
    const { router, plain } = channelSetup(
      { 'session-trip': { title: 'Trip planning' } },
      { telegram: 'session-trip' },
    )
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto', replyTarget: '42' })
    expect(plain).toEqual([
      {
        sessionRef: 'session-trip',
        text: 'add a day in Kyoto',
        origin: { channel: 'telegram', replyTo: '42' },
      },
    ])
    expect(ch.replies).toEqual([])
  })

  it('says it is starting on Slack, which shows no typing for it', async () => {
    const { router } = channelSetup(
      { 'session-trip': { title: 'Trip planning' } },
      { slack: 'session-trip' },
    )
    const ch = fakeChannel('slack')
    await router.route(ch.adapter, { text: 'add a day in Kyoto' })
    expect(ch.replies).toEqual(['➡️ Sent to "Trip planning" — starting…'])
  })

  it('starts a new Reachable Session when the Channel has none, and keeps using it', async () => {
    const { router, plain, created, pointers } = channelSetup()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'hello' })
    await router.route(ch.adapter, { text: 'and again' })
    expect(created).toEqual(['session-new-1'])
    expect(plain.map((p) => [p.sessionRef, p.text])).toEqual([
      ['session-new-1', 'hello'],
      ['session-new-1', 'and again'],
    ])
    expect(pointers.telegram).toBe('session-new-1')
    expect(ch.replies).toEqual([])
  })

  it('goes to each Channel’s own Channel Session', async () => {
    const { router, plain, pointers } = channelSetup(
      { 'session-trip': { title: 'Trip planning' }, 'session-code': { title: 'Refactor' } },
      { telegram: 'session-trip', slack: 'session-code' },
    )
    await router.route(fakeChannel('slack').adapter, { text: 'rename the module' })
    expect(plain.map((p) => p.sessionRef)).toEqual(['session-code'])
    expect(pointers).toEqual({ telegram: 'session-trip', slack: 'session-code' })
  })

  it.each([
    ['deleted', { title: 'Trip planning', gone: true }],
    ['no longer reachable', { title: 'Trip planning', reachable: false }],
  ])(
    'tells the Channel once when its Channel Session was %s, then starts a new one',
    async (_how, old) => {
      const { router, plain, created, pointers } = channelSetup(
        { 'session-trip': old },
        { telegram: 'session-trip' },
      )
      const ch = fakeChannel('telegram')
      await router.route(ch.adapter, { text: 'hello' })
      await router.route(ch.adapter, { text: 'and again' })
      expect(ch.replies).toEqual([
        '⚠️ Your Channel Session was deleted or is no longer reachable, so this message starts a new one.',
      ])
      expect(created).toEqual(['session-new-1'])
      expect(plain.map((p) => p.sessionRef)).toEqual(['session-new-1', 'session-new-1'])
      expect(pointers.telegram).toBe('session-new-1')
    },
  )

  it('says so when no Session could be started, and sends nothing', async () => {
    const { router, plain, creation, pointers } = channelSetup()
    creation.fails = true
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'hello' })
    expect(plain).toEqual([])
    expect(pointers.telegram).toBeUndefined()
    expect(ch.replies).toEqual(['⚠️ Could not start a new Session: disk full'])
  })

  it.each([
    ['busy', 'turn in flight', false],
    ['settings-problems', 'The selected model is not installed.', true],
    ['missing-folder', 'The workspace folder is missing: /files', true],
  ])('replies with a %s refusal', async (reason, message, onDesktop) => {
    const { router } = channelSetup(
      { 'session-trip': { title: 'Trip planning', result: { ok: false, reason, message } } },
      { telegram: 'session-trip' },
    )
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'hello' })
    const notSent = `⚠️ Not sent to "Trip planning": ${message}`
    expect(ch.replies).toEqual([
      onDesktop
        ? `${notSent}\nFix it in AI Playground on your computer, then answer again.`
        : notSent,
    ])
  })

  it.each([
    ['photo', { text: '[image]', images: [{ mime: 'image/jpeg', data_base64: 'AAAA' }] }],
    [
      'document',
      { documents: [{ filename: 'plan.txt', mime: 'text/plain', data_base64: 'AAAA' }] },
    ],
  ])('refuses a %s for now, and sends nothing', async (_kind, attachment) => {
    const { router, plain } = channelSetup(
      { 'session-trip': { title: 'Trip planning' } },
      { telegram: 'session-trip' },
    )
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, attachment)
    expect(plain).toEqual([])
    expect(ch.replies).toEqual([
      "⚠️ Images, documents and voice messages can't be sent to a Session yet. Send text instead.",
    ])
  })

  it('passes on the channel’s notice for a file it refused to read', async () => {
    const { router, plain } = channelSetup()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'the plan', refused: 'Files over 25 MB are not taken.' })
    expect(plain).toEqual([])
    expect(ch.replies).toEqual(['Files over 25 MB are not taken.'])
  })
})

describe('Channel commands', () => {
  const trip = { title: 'Trip planning', transcript: [] as ChannelTranscriptMessage[] }
  const code = {
    title: 'Refactor',
    transcript: [
      { role: 'user' as const, parts: [{ type: 'text', text: 'split the module' }] },
      { role: 'assistant' as const, parts: [{ type: 'text', text: 'Done, two files now.' }] },
    ],
  }

  it('lists the Reachable Sessions newest first as buttons', async () => {
    const { router } = channelSetup({ 'session-trip': trip, 'session-code': code })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/sessions' })
    expect(ch.keyboards).toEqual([
      {
        text: 'Reachable Sessions, newest first. Tap one to continue it, or send /load <n>.',
        buttons: [
          [{ text: '1. Trip planning', callbackData: 'loadConv:session-trip' }],
          [{ text: '2. Refactor', callbackData: 'loadConv:session-code' }],
        ],
      },
    ])
  })

  it('marks the Channel Session in the list', async () => {
    const { router } = channelSetup(
      { 'session-trip': trip, 'session-code': code },
      { telegram: 'session-code' },
    )
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/sessions' })
    expect(ch.keyboards[0].buttons.map((row) => row[0].text)).toEqual([
      '1. Trip planning',
      '✅ 2. Refactor',
    ])
  })

  it('names an untitled Session in the list', async () => {
    const { router } = channelSetup({ 'session-new': { title: '' } })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/sessions' })
    expect(ch.keyboards[0].buttons[0][0].text).toBe('1. Untitled Session')
  })

  it('says when no Session is reachable', async () => {
    const { router } = channelSetup({ 'session-private': { title: 'Taxes', reachable: false } })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/sessions' })
    expect(ch.keyboards).toEqual([])
    expect(ch.replies).toEqual([
      'No Session is reachable yet. Send a message to start one, or turn on "Reachable from Channels" in a Session’s menu on your computer.',
    ])
  })

  it('lists the Sessions for a bare /load', async () => {
    const { router } = channelSetup({ 'session-trip': trip })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/load' })
    expect(ch.keyboards).toHaveLength(1)
  })

  it('makes a listed Session the Channel Session with /load <n>', async () => {
    const { router, plain, pointers } = channelSetup(
      { 'session-trip': trip, 'session-code': code },
      { telegram: 'session-trip' },
    )
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/load 2' })
    expect(pointers.telegram).toBe('session-code')
    expect(ch.replies).toEqual(['📂 Now in "Refactor". Your messages go there.'])
    await router.route(ch.adapter, { text: 'and tests?' })
    expect(plain.map((p) => p.sessionRef)).toEqual(['session-code'])
  })

  it('makes a tapped Session the Channel Session', async () => {
    const { router, pointers } = channelSetup({ 'session-trip': trip, 'session-code': code })
    const ch = fakeChannel('local-web')
    await router.route(ch.adapter, { callback: 'loadConv:session-code' })
    expect(pointers['local-web']).toBe('session-code')
  })

  it('takes the Session a platform turned a tap into /load for', async () => {
    const { router, pointers } = channelSetup({ 'session-trip': trip, 'session-code': code })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/load session-code' })
    expect(pointers.telegram).toBe('session-code')
  })

  it.each([
    ['a number past the list', '/load 3'],
    ['a Session that is not reachable', '/load session-private'],
  ])('refuses %s and keeps the Channel Session', async (_what, text) => {
    const { router, pointers } = channelSetup(
      {
        'session-trip': trip,
        'session-code': code,
        'session-private': { title: 'Taxes', reachable: false },
      },
      { telegram: 'session-trip' },
    )
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text })
    expect(pointers.telegram).toBe('session-trip')
    expect(ch.replies).toEqual([
      `⚠️ There is no Session ${text.slice('/load '.length)}. Send /sessions to see the list.`,
    ])
  })

  it('repaints LAN chat with the loaded Session’s transcript before confirming', async () => {
    const { router } = channelSetup({ 'session-trip': trip, 'session-code': code })
    const ch = fakeChannel('local-web')
    await router.route(ch.adapter, { text: '/load 2' })
    expect(ch.repaints).toEqual([
      [
        { role: 'user', text: 'split the module' },
        { role: 'assistant', text: 'Done, two files now.' },
      ],
    ])
    expect(ch.replies).toEqual(['📂 Now in "Refactor". Your messages go there.'])
  })

  it('starts a new Reachable Session with /new and points the Channel at it', async () => {
    const { router, created, pointers, plain } = channelSetup(
      { 'session-trip': trip },
      { telegram: 'session-trip' },
    )
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/new' })
    expect(created).toEqual(['session-new-1'])
    expect(pointers.telegram).toBe('session-new-1')
    expect(plain).toEqual([])
    expect(ch.replies).toEqual(['🆕 Started a new Session. Your next message goes to it.'])
  })

  it('clears LAN chat on /new', async () => {
    const { router } = channelSetup({ 'session-trip': trip }, { 'local-web': 'session-trip' })
    const ch = fakeChannel('local-web')
    await router.route(ch.adapter, { text: '/new' })
    expect(ch.repaints).toEqual([[]])
  })

  it('lists the commands that exist on /help', async () => {
    const { router } = channelSetup()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/help' })
    expect(ch.replies).toHaveLength(1)
    const [help] = ch.replies
    for (const command of ['/sessions', '/load', '/new', '/help']) expect(help).toContain(command)
    for (const gone of ['/imgGen', '/chat', '/history', '/reset', '/cancel']) {
      expect(help).not.toContain(gone)
    }
    expect(help).toContain('To answer an agent, reply to its message.')
  })

  it('names unknown commands and sends them nowhere', async () => {
    const { router, plain } = channelSetup()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/imgGen a cat' })
    expect(plain).toEqual([])
    expect(ch.replies).toEqual(['Unknown command /imgGen. Send /help to see the commands.'])
  })

  it('runs a command replied to a Notification as a command, not an Answer', async () => {
    const { router, received } = channelSetup({ 'session-trip': trip })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/help', replyTo: '1234' })
    expect(received).toEqual([])
    expect(ch.replies).toHaveLength(1)
  })

  it('runs a command while the Channel Session is busy', async () => {
    const { router, pointers } = channelSetup(
      { 'session-trip': { ...trip, result: BUSY }, 'session-code': code },
      { telegram: 'session-trip' },
    )
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'hello' })
    await router.route(ch.adapter, { text: '/load 2' })
    expect(pointers.telegram).toBe('session-code')
  })
})
