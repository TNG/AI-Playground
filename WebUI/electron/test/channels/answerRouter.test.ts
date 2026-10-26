import { describe, expect, it } from 'vitest'
import {
  createAnswerRouter,
  type AnswerSendResult,
  type AnswerSessions,
} from '../../../src/assets/js/store/channels/answerRouter'
import { createChannelQuestionRegistry } from '../../../src/assets/js/store/channels/channelQuestions'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type { ChannelKind, RemoteAudio } from '../../../src/assets/js/store/channels/types'

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

type FakeSession = { label: string; result?: AnswerSendResult; realShell?: boolean }

/** Agent sessions as the router sees them: which message each sent, and what a send does. */
type SentMessage = { kind: ChannelKind; ref: string; sessionId: string }

function fakeSessions(sessions: Record<string, FakeSession>, sentMessages: SentMessage[]) {
  const received: { sessionId: string; text: string }[] = []
  const port: AnswerSessions = {
    lookup: async (kind, ref) => {
      const sent = sentMessages.find((m) => m.kind === kind && m.ref === ref)
      if (!sent) return null
      return sessions[sent.sessionId] ? { sessionId: sent.sessionId } : { deletedSession: true }
    },
    label: (sessionId) => `"${sessions[sessionId]?.label ?? 'An agent run'}"`,
    usesRealShell: (sessionId) => !!sessions[sessionId]?.realShell,
    send: async (sessionId, text) => {
      received.push({ sessionId, text })
      return sessions[sessionId]?.result ?? { ok: true, queuePosition: null }
    },
  }
  return { port, received }
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

function setup(
  sessions: Record<string, FakeSession> = { asteroids: { label: 'Asteroids clone' } },
  sentMessages: SentMessage[] = [{ kind: 'telegram', ref: '1234', sessionId: 'asteroids' }],
) {
  const questions = createChannelQuestionRegistry({ newId: () => 'q1', log: () => {} })
  const fake = fakeSessions(sessions, sentMessages)
  const speech = fakeTranscription()
  const router = createAnswerRouter({
    sessions: () => fake.port,
    questions,
    transcribe: speech.transcribe,
    log: () => {},
  })
  return { router, questions, received: fake.received, speech }
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
      expect(ch.replies).toEqual(['➡️ Sent to "Asteroids clone" — starting…'])
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
})
