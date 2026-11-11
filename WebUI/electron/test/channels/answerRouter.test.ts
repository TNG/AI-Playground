import { describe, expect, it } from 'vitest'
import {
  createAnswerRouter,
  type SessionSendResult,
  type SessionPort,
  type SessionActivity,
  type SessionChange,
  type VoicePreparation,
  type ChannelSessionPointers,
  type ChannelTranscriptMessage,
} from '../../../src/assets/js/store/channels/answerRouter'
import { createChannelQuestionRegistry } from '../../../src/assets/js/store/channels/channelQuestions'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type { QueuedChannelMessage } from '../../../src/assets/js/store/channels/channelQueue'
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
  realShell?: boolean
  /** Reachable from Channels unless false. */
  reachable?: boolean
  /** The Session was deleted, though the message map still names it. */
  gone?: boolean
  /** Runs while a send is in flight, before it resolves. */
  duringSend?: () => void
  /** Its model cannot see images. */
  blind?: boolean
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
  blind?: boolean
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
  /** When on, a send that goes through starts a turn, so the Session is busy until it settles. */
  const turns = { start: false }
  const origins: { sessionId: string; origin: AgentAnswerOrigin }[] = []
  /** What each Session is busy with, by Session ref; idle when absent. */
  const activities: Record<string, SessionActivity> = {}
  const stopped: string[] = []
  const listeners = new Set<(sessionRef: string, change: SessionChange) => void>()
  const tellListeners = (sessionRef: string, change: SessionChange) => {
    for (const listener of [...listeners]) listener(sessionRef, change)
  }
  /** Files attached, by the Harness Session or Session they went to. */
  const attached: { to: string; kind: string; filename: string }[] = []
  const attaching = { fails: false }
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
        const result = channelSessions[target.sessionRef]?.result ?? {
          ok: true,
          queuePosition: null,
        }
        if (result.ok && turns.start) activities[target.sessionRef] = { kind: 'turn' }
        return result
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
      const result =
        queued && queued.length > 0
          ? queued.length > 1
            ? queued.shift()!
            : queued[0]
          : (session?.result ?? { ok: true, queuePosition: null })
      if (result.ok && turns.start) activities[sessionRef] = { kind: 'turn' }
      return result
    },
    attach: async (target, file) => {
      const answer = 'harnessSessionId' in target
      const to = answer ? target.harnessSessionId : target.sessionRef
      const blind = answer ? sessions[to]?.blind : channelSessions[to]?.blind
      if (file.kind === 'image' && blind) return { ok: false, reason: 'images-unseen', message: '' }
      if (attaching.fails) return { ok: false, reason: 'error', message: 'disk full' }
      attached.push({ to, kind: file.kind, filename: file.filename })
      return { ok: true, path: `attachments/${file.filename}` }
    },
    activity: (sessionRef) => activities[sessionRef] ?? { kind: 'idle' },
    stop: async (sessionRef) => {
      const was = activities[sessionRef] ?? { kind: 'idle' }
      stopped.push(sessionRef)
      delete activities[sessionRef]
      if (was.kind !== 'idle') tellListeners(sessionRef, 'settled')
      return was
    },
    onSessionChange: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  /**
   * The Session runs a turn, or an Agent Run, that later messages wait for; from then on each
   * send that goes through starts a turn too.
   */
  const busy = (sessionRef: string, activity: SessionActivity = { kind: 'turn' }) => {
    turns.start = true
    activities[sessionRef] = activity
  }
  /** The Session's turn or Agent Run settled. */
  const settle = async (sessionRef: string) => {
    delete activities[sessionRef]
    tellListeners(sessionRef, 'settled')
    await flush()
  }
  /** The Session stopped being reachable, or was deleted. */
  const change = async (sessionRef: string, how: Exclude<SessionChange, 'settled'>) => {
    tellListeners(sessionRef, how)
    await flush()
  }
  return {
    port,
    received,
    origins,
    plain,
    created,
    creation,
    busy,
    settle,
    change,
    stopped,
    attached,
    attaching,
  }
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

/** Readying speech-to-text for a voice message: a download waits until the test lets it through. */
function fakeVoicePreparation() {
  const waiting: { finish: (ready: boolean) => void }[] = []
  let gated = false
  const prepare = async (): Promise<VoicePreparation> =>
    gated
      ? { downloading: new Promise<boolean>((finish) => waiting.push({ finish })) }
      : { ready: true }
  return {
    waiting,
    prepare,
    /** Every following voice message waits, as for a speech model download. */
    needDownload: () => {
      gated = true
    },
  }
}

const voice = (data: string) => ({ audio: [{ mime: 'audio/ogg', data_base64: data }] })

function setup(
  sessions: Record<string, FakeSession> = { asteroids: { label: 'Asteroids clone' } },
  sentMessages: SentMessage[] = [
    { kind: 'telegram', ref: '1234', sessionId: 'asteroids' },
    { kind: 'slack', ref: '1234', sessionId: 'asteroids' },
  ],
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
  const published: Record<string, QueuedChannelMessage[]> = {}
  const router = createAnswerRouter({
    sessions: () => fake.port,
    questions,
    speech: { prepare: voicePreparation.prepare, transcribe: speech.transcribe },
    downloadQuestionChannels: () => downloads.askedOn,
    pointers: channelPointers.pointers,
    publishQueue: (sessionRef, queued) => {
      published[sessionRef] = queued
    },
    log: () => {},
  })
  return {
    router,
    questions,
    ...fake,
    sessions,
    speech,
    voicePreparation,
    downloads,
    published,
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
  })
})

describe('a message to a busy Session', () => {
  const TRIP = 'session-trip'
  function busyTrip(kind: ChannelKind = 'telegram') {
    const fixture = channelSetup({ [TRIP]: { title: 'Trip planning' } }, { [kind]: TRIP })
    fixture.busy(TRIP)
    return fixture
  }

  it('is queued, not sent, and acknowledged with its place and what it waits for', async () => {
    const { router, plain } = busyTrip()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto' })
    expect(plain).toEqual([])
    expect(ch.replies).toEqual([
      '⏳ Queued (1st) for "Trip planning", runs after the current turn.',
    ])
  })

  it('runs once the turn ends, replying on its Channel', async () => {
    const { router, plain, settle } = busyTrip()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto', replyTarget: '42' })
    await settle(TRIP)
    expect(plain).toEqual([
      {
        sessionRef: TRIP,
        text: 'add a day in Kyoto',
        origin: { channel: 'telegram', replyTo: '42' },
      },
    ])
  })
  it('keeps every message, never replacing one, and names each place', async () => {
    const { router, plain, settle } = busyTrip()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto' })
    await router.route(ch.adapter, { text: 'and one in Nara' })
    await router.route(ch.adapter, { text: 'keep it cheap' })
    expect(ch.replies).toEqual([
      '⏳ Queued (1st) for "Trip planning", runs after the current turn.',
      '⏳ Queued (2nd) for "Trip planning", runs after the current turn.',
      '⏳ Queued (3rd) for "Trip planning", runs after the current turn.',
    ])
    await settle(TRIP)
    expect(plain.map((p) => p.text)).toEqual([
      'add a day in Kyoto\n\nand one in Nara\n\nkeep it cheap',
    ])
  })

  it('keeps a voice message’s transcript and voice origin while it waits', async () => {
    const { router, plain, settle, speech } = busyTrip()
    speech.said['ogg-1'] = 'add a day in Kyoto'
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, voice('ogg-1'))
    expect(ch.replies).toEqual([
      '⏳ Queued (1st) for "Trip planning", runs after the current turn.',
    ])
    await settle(TRIP)
    expect(plain).toEqual([
      {
        sessionRef: TRIP,
        text: 'add a day in Kyoto',
        origin: { channel: 'telegram', voice: true },
      },
    ])
  })

  it('replies to the combined turn under the last message', async () => {
    const { router, plain, settle } = busyTrip()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto', replyTarget: '41' })
    await router.route(ch.adapter, { text: 'and one in Nara', replyTarget: '42' })
    await settle(TRIP)
    expect(plain.map((p) => p.origin)).toEqual([{ channel: 'telegram', replyTo: '42' }])
  })

  it('runs one combined turn per Channel, oldest Channel first, each when the last ends', async () => {
    const { router, plain, settle, busy } = channelSetup(
      { [TRIP]: { title: 'Trip planning' } },
      { telegram: TRIP, slack: TRIP },
    )
    busy(TRIP)
    const slack = fakeChannel('slack')
    const telegram = fakeChannel('telegram')
    await router.route(slack.adapter, { text: 'book the ryokan' })
    await router.route(telegram.adapter, { text: 'add a day in Kyoto' })
    await router.route(slack.adapter, { text: 'with breakfast' })
    expect(slack.replies[1]).toBe(
      '⏳ Queued (3rd) for "Trip planning", runs after the current turn.',
    )
    busy(TRIP)
    await settle(TRIP)
    expect(plain.map((p) => [p.origin.channel, p.text])).toEqual([
      ['slack', 'book the ryokan\n\nwith breakfast'],
    ])
    busy(TRIP)
    await settle(TRIP)
    expect(plain.map((p) => [p.origin.channel, p.text])).toEqual([
      ['slack', 'book the ryokan\n\nwith breakfast'],
      ['telegram', 'add a day in Kyoto'],
    ])
  })

  it('waits for an Agent Run’s last Step, naming the run and its Step', async () => {
    const { router, plain, busy, settle } = channelSetup(
      { [TRIP]: { title: 'Trip planning' } },
      { telegram: TRIP },
    )
    busy(TRIP, { kind: 'agent-run', name: 'Digest', step: 2, steps: 3 })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add sources' })
    expect(ch.replies).toEqual([
      '⏳ Queued (1st) for "Trip planning", runs after Agent Run “Digest” (Step 2 of 3).',
    ])
    expect(plain).toEqual([])
    await settle(TRIP)
    expect(plain.map((p) => p.text)).toEqual(['add sources'])
  })

  it('says a queued message waits on the computer while the turn is paused there', async () => {
    const { router, busy } = busyTrip()
    busy(TRIP, { kind: 'turn', paused: 'desktop' })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'go ahead' })
    expect(ch.replies).toEqual([
      '⏳ Queued (1st) for "Trip planning", runs after the current turn.\n' +
        'The turn is waiting on your computer.',
    ])
  })

  it.each([
    [['telegram'], 'The turn is waiting for the download buttons above.'],
    [
      ['slack'],
      'The turn is waiting for the download buttons in your notifications chat, or on your computer.',
    ],
    [[], 'The turn is waiting on your computer.'],
  ] as [ChannelKind[], string][])(
    'says where a paused download is asked (asked on %j)',
    async (askedOn, line) => {
      const { router, busy, downloads } = busyTrip()
      downloads.askedOn = askedOn
      busy(TRIP, { kind: 'turn', paused: 'download' })
      const ch = fakeChannel('telegram')
      await router.route(ch.adapter, { text: 'use the small one' })
      expect(ch.replies[0].split('\n')[1]).toBe(line)
    },
  )

  it('refuses the 11th queued message with a reply naming /stop', async () => {
    const { router, plain, settle } = busyTrip()
    const ch = fakeChannel('telegram')
    for (let n = 1; n <= 11; n++) await router.route(ch.adapter, { text: `idea ${n}` })
    expect(ch.replies[10]).toBe(
      '⚠️ Not queued: "Trip planning" already has 10 messages waiting. ' +
        'Send /stop to stop it and drop them.',
    )
    await settle(TRIP)
    expect(plain[0].text.split('\n\n')).toEqual(
      Array.from({ length: 10 }, (_, i) => `idea ${i + 1}`),
    )
  })

  it('counts every Channel against the cap of 10', async () => {
    const { router, busy } = channelSetup(
      { [TRIP]: { title: 'Trip planning' } },
      { telegram: TRIP, slack: TRIP },
    )
    busy(TRIP)
    const telegram = fakeChannel('telegram')
    const slack = fakeChannel('slack')
    for (let n = 1; n <= 10; n++) await router.route(telegram.adapter, { text: `idea ${n}` })
    await router.route(slack.adapter, { text: 'one more' })
    expect(slack.replies[0]).toContain('Not queued')
  })

  it('queues a message the Session refused as busy, and runs it when the turn ends', async () => {
    const { router, plain, busy, settle } = channelSetup(
      { [TRIP]: { title: 'Trip planning', result: BUSY } },
      { telegram: TRIP },
    )
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto' })
    expect(ch.replies).toEqual([
      '⏳ Queued (1st) for "Trip planning", runs after the current turn.',
    ])
    busy(TRIP)
    await settle(TRIP)
    expect(plain.at(-1)?.text).toBe('add a day in Kyoto')
    expect(ch.replies).toHaveLength(1)
  })

  it('queues an Answer an Agent Run refused, and sends it once the run settles', async () => {
    const { router, received, busy, settle } = setup({
      asteroids: {
        label: 'Asteroids clone',
        results: [TASK_LOCKED, { ok: true, queuePosition: null }],
      },
    })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a summary', replyTo: '1234' })
    expect(ch.replies).toEqual([
      '⏳ Queued (1st) for "Asteroids clone", runs after the current turn.',
    ])
    busy(sessionRefOf('asteroids'))
    await settle(sessionRefOf('asteroids'))
    expect(received.at(-1)).toEqual({ sessionId: 'asteroids', text: 'add a summary' })
  })

  it('tells the Channel when its combined turn could not be sent', async () => {
    const { router, busy, settle } = channelSetup(
      {
        [TRIP]: {
          title: 'Trip planning',
          result: { ok: false, reason: 'settings-problems', message: 'No model.' },
        },
      },
      { telegram: TRIP },
    )
    busy(TRIP)
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto' })
    await settle(TRIP)
    expect(ch.replies[1]).toBe(
      '⚠️ Not sent to "Trip planning": No model.\n' +
        'Fix it in AI Playground on your computer, then answer again.',
    )
  })

  it('publishes the queue for the desktop, and empties it when the turn starts', async () => {
    const { router, settle, published } = busyTrip()
    const telegram = fakeChannel('telegram')
    await router.route(telegram.adapter, { text: 'add a day in Kyoto' })
    expect(published[TRIP]).toEqual([
      { id: expect.any(String), channel: 'telegram', text: 'add a day in Kyoto' },
    ])
    await settle(TRIP)
    expect(published[TRIP]).toEqual([])
  })

  it('drops the queue when the Session is made unreachable, telling each Channel', async () => {
    const { router, plain, settle, change, published } = busyTrip()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto' })
    await router.route(ch.adapter, { text: 'and Nara' })
    await change(TRIP, 'unreachable')
    expect(ch.replies[2]).toBe(
      '⚠️ Your queued messages for "Trip planning" were dropped (2): ' +
        'it is no longer reachable from Channels.',
    )
    expect(published[TRIP]).toEqual([])
    await settle(TRIP)
    expect(plain).toEqual([])
  })

  it('drops the queue when the Session is deleted, telling each Channel', async () => {
    const { router, change } = busyTrip()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto' })
    await change(TRIP, 'deleted')
    expect(ch.replies[1]).toBe(
      '⚠️ Your queued messages for "Trip planning" were dropped (1): the Session was deleted.',
    )
  })
})

describe('an Answer to a busy Session', () => {
  const ASTEROIDS = sessionRefOf('asteroids')

  it('is queued, and runs in its Harness Session once the turn ends', async () => {
    const { router, received, busy, settle } = setup()
    busy(ASTEROIDS)
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    expect(received).toEqual([])
    expect(ch.replies).toEqual([
      '⏳ Queued (1st) for "Asteroids clone", runs after the current turn.',
    ])
    await settle(ASTEROIDS)
    expect(received).toEqual([{ sessionId: 'asteroids', text: 'make it faster' }])
  })

  it('is never combined with a plain message to the same Session', async () => {
    const { router, received, plain, busy, settle } = setup(
      undefined,
      undefined,
      { [ASTEROIDS]: { title: 'Asteroids' } },
      { telegram: ASTEROIDS },
    )
    busy(ASTEROIDS)
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    await router.route(ch.adapter, { text: 'and what about sound?' })
    busy(ASTEROIDS)
    await settle(ASTEROIDS)
    expect(received.map((r) => r.text)).toEqual(['make it faster'])
    expect(plain).toEqual([])
    await settle(ASTEROIDS)
    expect(plain.map((p) => p.text)).toEqual(['and what about sound?'])
  })

  it('says it is starting on Slack once its queued turn is sent', async () => {
    const { router, busy, settle } = setup()
    busy(ASTEROIDS)
    const ch = fakeChannel('slack')
    await router.route(ch.adapter, { text: 'make it faster', replyTo: '1234' })
    await settle(ASTEROIDS)
    expect(ch.replies).toEqual([
      '⏳ Queued (1st) for "Asteroids clone", runs after the current turn.',
      '➡️ Sent to "Asteroids clone" — starting…',
    ])
  })
})

describe('/stop', () => {
  const TRIP = 'session-trip'
  const trip = { [TRIP]: { title: 'Trip planning' } }

  it('stops the Channel Session’s turn and drops its queue, saying how many', async () => {
    const { router, plain, busy, stopped, settle } = channelSetup(trip, { telegram: TRIP })
    busy(TRIP)
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: 'add a day in Kyoto' })
    await router.route(ch.adapter, { text: 'and Nara' })
    await router.route(ch.adapter, { text: '/stop' })
    expect(stopped).toEqual([TRIP])
    expect(ch.replies.slice(2)).toEqual([
      '⏹️ Stopped the turn in "Trip planning".\nQueued messages dropped: 2.',
    ])
    await settle(TRIP)
    expect(plain).toEqual([])
  })

  it('stops an Agent Run, between its Steps too, naming it and its Step', async () => {
    const { router, busy, stopped } = channelSetup(trip, { telegram: TRIP })
    busy(TRIP, { kind: 'agent-run', name: 'Digest', step: 2, steps: 3 })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/stop' })
    expect(stopped).toEqual([TRIP])
    expect(ch.replies).toEqual([
      '⏹️ Stopped Agent Run “Digest” in "Trip planning" at Step 2 of 3.\n' +
        'Queued messages dropped: 0.',
    ])
  })

  it('tells another Channel whose queued messages it dropped', async () => {
    const { router, busy } = channelSetup(trip, { telegram: TRIP, slack: TRIP })
    busy(TRIP)
    const slack = fakeChannel('slack')
    const telegram = fakeChannel('telegram')
    await router.route(slack.adapter, { text: 'book the ryokan' })
    await router.route(telegram.adapter, { text: '/stop' })
    expect(telegram.replies).toEqual([
      '⏹️ Stopped the turn in "Trip planning".\nQueued messages dropped: 1.',
    ])
    expect(slack.replies[1]).toBe(
      '⚠️ Your queued messages for "Trip planning" were dropped (1): ' +
        'it was stopped from another Channel.',
    )
  })

  it('stops the Session of the Notification it replies to', async () => {
    const { router, busy, stopped } = setup(
      undefined,
      undefined,
      { [TRIP]: { title: 'Trip planning' } },
      { telegram: TRIP },
    )
    busy(sessionRefOf('asteroids'))
    busy(TRIP)
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/stop', replyTo: '1234' })
    expect(stopped).toEqual([sessionRefOf('asteroids')])
    expect(ch.replies).toEqual([
      '⏹️ Stopped the turn in "Untitled Session".\nQueued messages dropped: 0.',
    ])
  })

  it('says a Notification’s Session was deleted, and stops nothing', async () => {
    const { router, stopped } = setup({}, [{ kind: 'telegram', ref: '1234', sessionId: 'gone' }])
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/stop', replyTo: '1234' })
    expect(stopped).toEqual([])
    expect(ch.replies).toEqual(['⚠️ That Session was deleted'])
  })

  it('says nothing is running, and touches nothing, when the Session is idle', async () => {
    const { router, stopped } = channelSetup(trip, { telegram: TRIP })
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/stop' })
    expect(stopped).toEqual([])
    expect(ch.replies).toEqual(['Nothing is running in "Trip planning".'])
  })

  it('says how to get a Channel Session when the Channel has none', async () => {
    const { router, stopped, created } = channelSetup()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/stop' })
    expect(stopped).toEqual([])
    expect(created).toEqual([])
    expect(ch.replies).toEqual([
      'You have no Channel Session to stop. Send a message to start one, or pick one with /sessions.',
    ])
  })

  it('is listed in /help', async () => {
    const { router } = channelSetup()
    const ch = fakeChannel('telegram')
    await router.route(ch.adapter, { text: '/help' })
    expect(ch.replies[0]).toContain(
      '`/stop` — Stop the running turn or Agent Run and drop queued messages',
    )
  })
})

/** A router whose Channels reach these Sessions, newest first, with these Channel Sessions. */
function channelSetup(
  channelSessions: Record<string, FakeChannelSession> = {},
  pointers: Partial<Record<ChannelKind, string>> = {},
) {
  return setup(undefined, undefined, channelSessions, pointers)
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

describe('a voice message', () => {
  const trip = () =>
    channelSetup(
      { 'session-trip': { title: 'Trip planning' } },
      {
        telegram: 'session-trip',
      },
    )

  it('is transcribed and sent to the Channel Session like typed text, marked as spoken', async () => {
    const { router, plain, speech } = trip()
    speech.said['ogg-1'] = 'add a day in Kyoto'
    const ch = fakeChannel()
    await router.route(ch.adapter, { ...voice('ogg-1'), replyTarget: '42' })
    expect(plain).toEqual([
      {
        sessionRef: 'session-trip',
        text: 'add a day in Kyoto',
        origin: { channel: 'telegram', replyTo: '42', voice: true },
      },
    ])
    expect(ch.replies).toEqual([])
  })

  it('runs a spoken command', async () => {
    const { router, plain, speech } = trip()
    speech.said['ogg-1'] = '/sessions'
    const ch = fakeChannel()
    await router.route(ch.adapter, voice('ogg-1'))
    expect(plain).toEqual([])
    expect(ch.keyboards.map((k) => k.buttons.flat().map((b) => b.text))).toEqual([
      ['✅ 1. Trip planning'],
    ])
  })

  it('answers an agent when it replies to its Notification', async () => {
    const { router, received, origins, speech } = setup()
    speech.said['ogg-1'] = 'try a smaller level'
    const ch = fakeChannel()
    await router.route(ch.adapter, { ...voice('ogg-1'), replyTo: '1234' })
    expect(received).toEqual([{ sessionId: 'asteroids', text: 'try a smaller level' }])
    expect(origins.map((o) => o.origin)).toEqual([{ channel: 'telegram', voice: true }])
  })

  it('keeps the caption it came with in front of what was said', async () => {
    const { router, plain, speech } = trip()
    speech.said['ogg-1'] = 'two nights'
    await router.route(fakeChannel().adapter, { text: 'Kyoto:', ...voice('ogg-1') })
    expect(plain.map((p) => p.text)).toEqual(['Kyoto: two nights'])
  })

  it('keeps the Channel’s later messages behind it while its speech model downloads', async () => {
    const { router, plain, speech, voicePreparation } = trip()
    speech.said['ogg-1'] = 'add a day in Kyoto'
    voicePreparation.needDownload()
    const ch = fakeChannel()
    await router.route(ch.adapter, voice('ogg-1'))
    await router.route(ch.adapter, { text: 'and one in Nara' })
    await flush()
    expect(plain).toEqual([])
    voicePreparation.waiting[0].finish(true)
    await flush()
    await flush()
    expect(plain.map((p) => p.text)).toEqual(['add a day in Kyoto', 'and one in Nara'])
  })

  it('lets the download question be answered while it waits', async () => {
    const { router, questions, speech, voicePreparation } = trip()
    speech.said['ogg-1'] = 'add a day in Kyoto'
    voicePreparation.needDownload()
    const ch = fakeChannel()
    await router.route(ch.adapter, voice('ogg-1'))
    const tapped = questions.ask({ adapter: ch.adapter, summaryMarkdown: 'Download Whisper?' })
    await flush()
    await router.route(ch.adapter, { callback: 'confirm:q1:yes' })
    await expect(tapped.answer).resolves.toBe(true)
  })

  it('lets a typed yes answer a question while it waits', async () => {
    const { router, questions, speech, voicePreparation, plain } = trip()
    speech.said['ogg-1'] = 'add a day in Kyoto'
    voicePreparation.needDownload()
    const ch = fakeChannel()
    await router.route(ch.adapter, voice('ogg-1'))
    const typed = questions.ask({
      adapter: ch.adapter,
      summaryMarkdown: 'Download Whisper?',
      typedReply: true,
    })
    await flush()
    await router.route(ch.adapter, { text: 'yes' })
    await expect(typed.answer).resolves.toBe(true)
    expect(plain).toEqual([])
  })

  it('holds up no other Channel while its speech model downloads', async () => {
    const { router, plain, speech, voicePreparation } = channelSetup(
      { 'session-trip': { title: 'Trip planning' }, 'session-code': { title: 'Refactor' } },
      { telegram: 'session-trip', slack: 'session-code' },
    )
    speech.said['ogg-1'] = 'add a day in Kyoto'
    voicePreparation.needDownload()
    await router.route(fakeChannel('telegram').adapter, voice('ogg-1'))
    await router.route(fakeChannel('slack').adapter, { text: 'rename the module' })
    expect(plain.map((p) => p.text)).toEqual(['rename the module'])
  })

  it('is dropped unheard when its speech model was not readied', async () => {
    const { router, plain, speech, voicePreparation } = trip()
    speech.said['ogg-1'] = 'add a day in Kyoto'
    voicePreparation.needDownload()
    const ch = fakeChannel()
    await router.route(ch.adapter, voice('ogg-1'))
    voicePreparation.waiting[0].finish(false)
    await flush()
    expect(speech.transcribed).toEqual([])
    expect(plain).toEqual([])
  })

  it('sends nothing when transcription failed, leaving the explanation to it', async () => {
    const { router, plain, speech } = trip()
    speech.said['ogg-1'] = null
    const ch = fakeChannel()
    await router.route(ch.adapter, voice('ogg-1'))
    expect(plain).toEqual([])
    expect(ch.replies).toEqual([])
  })

  it('says so when no speech was heard, and sends nothing', async () => {
    const { router, plain, speech } = trip()
    speech.said['ogg-1'] = ''
    const ch = fakeChannel()
    await router.route(ch.adapter, voice('ogg-1'))
    expect(plain).toEqual([])
    expect(ch.replies).toEqual([
      "🎙️ Couldn't make out any speech in that voice message, so nothing was sent.",
    ])
  })
})

describe('a file', () => {
  const photo = { images: [{ mime: 'image/jpeg', data_base64: 'AAAA' }] }
  const plan = {
    documents: [{ filename: 'plan.pdf', mime: 'application/pdf', data_base64: 'AAAA' }],
  }
  const trip = (session: FakeChannelSession = { title: 'Trip planning' }) =>
    channelSetup({ 'session-trip': session }, { telegram: 'session-trip' })

  it('stores an image in the Session’s attachments and names it in the prompt', async () => {
    const { router, plain, attached } = trip()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'where is this?', ...photo })
    expect(attached).toEqual([
      { to: 'session-trip', kind: 'image', filename: 'telegram-image.jpg' },
    ])
    expect(plain.map((p) => p.text)).toEqual([
      'where is this?\n\nAttached files, saved in the workspace: @attachments/telegram-image.jpg',
    ])
    expect(ch.replies).toEqual([])
  })

  it('sends an image without a caption on its own', async () => {
    const { router, plain } = trip()
    await router.route(fakeChannel().adapter, photo)
    expect(plain.map((p) => p.text)).toEqual([
      'Attached files, saved in the workspace: @attachments/telegram-image.jpg',
    ])
  })

  it('says so when the Session’s model cannot see images, and sends nothing', async () => {
    const { router, plain, attached } = trip({ title: 'Trip planning', blind: true })
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'where is this?', ...photo })
    expect(plain).toEqual([])
    expect(attached).toEqual([])
    expect(ch.replies).toEqual([
      '⚠️ Not sent: "Trip planning" runs on a model that cannot see images. ' +
        'Pick a vision model for it on your computer, then send the image again.',
    ])
  })

  it('makes a document an Attached Document and confirms it without running a turn', async () => {
    const { router, plain, attached } = trip()
    const ch = fakeChannel()
    await router.route(ch.adapter, plan)
    expect(attached).toEqual([{ to: 'session-trip', kind: 'document', filename: 'plan.pdf' }])
    expect(plain).toEqual([])
    expect(ch.replies).toEqual([
      '📄 Attached to "Trip planning": plan.pdf. Ask about them in your next message.',
    ])
  })

  it('runs the turn for a document sent with a question', async () => {
    const { router, plain, attached } = trip()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'what does day 2 say?', ...plan })
    expect(attached.map((a) => a.filename)).toEqual(['plan.pdf'])
    expect(plain.map((p) => p.text)).toEqual(['what does day 2 say?'])
    expect(ch.replies).toEqual([])
  })

  it('starts a Channel Session for a document when the Channel has none', async () => {
    const { router, attached, created } = channelSetup()
    await router.route(fakeChannel().adapter, plan)
    expect(created).toEqual(['session-new-1'])
    expect(attached.map((a) => a.to)).toEqual(['session-new-1'])
  })

  it('goes with an Answer into the answered agent’s Harness Session', async () => {
    const { router, received, attached } = setup()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'use this sprite', ...photo, replyTo: '1234' })
    expect(attached).toEqual([{ to: 'asteroids', kind: 'image', filename: 'telegram-image.jpg' }])
    expect(received).toEqual([
      {
        sessionId: 'asteroids',
        text: 'use this sprite\n\nAttached files, saved in the workspace: @attachments/telegram-image.jpg',
      },
    ])
  })

  it('confirms a document sent alone as an Answer without running a turn', async () => {
    const { router, received, attached } = setup()
    const ch = fakeChannel()
    await router.route(ch.adapter, { ...plan, replyTo: '1234' })
    expect(attached.map((a) => [a.to, a.filename])).toEqual([['asteroids', 'plan.pdf']])
    expect(received).toEqual([])
    expect(ch.replies).toEqual([
      '📄 Attached to "Asteroids clone": plan.pdf. Ask about them in your next message.',
    ])
  })

  it('refuses an image for an agent whose model cannot see images', async () => {
    const { router, received } = setup({ asteroids: { label: 'Asteroids clone', blind: true } })
    const ch = fakeChannel()
    await router.route(ch.adapter, { ...photo, replyTo: '1234' })
    expect(received).toEqual([])
    expect(ch.replies).toEqual([
      '⚠️ Not sent: "Asteroids clone" runs on a model that cannot see images. ' +
        'Pick a vision model for it on your computer, then send the image again.',
    ])
  })

  it('attaches nothing to a real-shell Session', async () => {
    const { router, attached } = setup({ asteroids: { label: 'Asteroids clone', realShell: true } })
    await router.route(fakeChannel().adapter, { ...plan, replyTo: '1234' })
    expect(attached).toEqual([])
  })

  it('refuses a file over 25 MB, and attaches and sends nothing', async () => {
    const { router, plain, attached } = trip()
    const big = 'A'.repeat(Math.ceil((25 * 1024 * 1024) / 3) * 4 + 4)
    const ch = fakeChannel()
    await router.route(ch.adapter, {
      text: 'the plan',
      documents: [{ filename: 'atlas.pdf', mime: 'application/pdf', data_base64: big }],
    })
    expect(plain).toEqual([])
    expect(attached).toEqual([])
    expect(ch.replies).toEqual(['⚠️ Not sent: atlas.pdf is over 25 MB.'])
  })

  it.each([
    [
      'document',
      { documents: [{ filename: 'budget.xlsx', mime: 'application/zip', data_base64: 'AAAA' }] },
      'budget.xlsx',
    ],
    ['image', { images: [{ mime: 'image/heic', data_base64: 'AAAA' }] }, 'telegram-image.heic'],
  ])('refuses a %s of a type a Session does not take', async (_kind, file, name) => {
    const { router, plain, attached } = trip()
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'have a look', ...file })
    expect(plain).toEqual([])
    expect(attached).toEqual([])
    expect(ch.replies).toEqual([
      `⚠️ Not sent: ${name} is not a file a Session takes. ` +
        'Send an image, or a txt, md, doc, docx or pdf document.',
    ])
  })

  it('refuses a file before transcribing the voice it came with', async () => {
    const { router, speech } = trip()
    await router.route(fakeChannel().adapter, {
      ...voice('ogg-1'),
      documents: [{ filename: 'budget.xlsx', mime: 'application/zip', data_base64: 'AAAA' }],
    })
    expect(speech.transcribed).toEqual([])
  })

  it('says so when a file could not be attached, and sends nothing', async () => {
    const { router, plain, attaching } = trip()
    attaching.fails = true
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'what does day 2 say?', ...plan })
    expect(plain).toEqual([])
    expect(ch.replies).toEqual(['⚠️ Not sent: plan.pdf could not be attached: disk full'])
  })
})
