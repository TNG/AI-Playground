import { describe, expect, it } from 'vitest'
import {
  createAnswerRouter,
  type AnswerSendResult,
  type AnswerSessions,
} from '../../../src/assets/js/store/channels/answerRouter'
import { createChannelQuestionRegistry } from '../../../src/assets/js/store/channels/channelQuestions'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type { ChannelKind } from '../../../src/assets/js/store/channels/types'

function fakeChannel(kind: ChannelKind = 'telegram') {
  const replies: string[] = []
  const prompts: { text: string; placeholder: string }[] = []
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
    answerPrompt: async (text: string, placeholder: string) => {
      prompts.push({ text, placeholder })
      return { success: true, ref: { messageId: 900 + prompts.length } }
    },
  } as unknown as ChannelAdapter
  return { adapter, replies, prompts }
}

type FakeSession = { label: string; result?: AnswerSendResult }

/** Agent sessions as the router sees them: which message each sent, and what a send does. */
function fakeSessions(
  sessions: Record<string, FakeSession>,
  sentMessages: { kind: ChannelKind; ref: string; sessionId: string }[],
) {
  const received: { sessionId: string; text: string }[] = []
  const port: AnswerSessions = {
    lookup: async (kind, ref) =>
      sentMessages.find((m) => m.kind === kind && m.ref === ref)?.sessionId ?? null,
    label: (sessionId) => `"${sessions[sessionId]?.label ?? 'An agent run'}"`,
    record: async (kind, ref, sessionId) => {
      sentMessages.push({ kind, ref, sessionId })
    },
    send: async (sessionId, text) => {
      received.push({ sessionId, text })
      return sessions[sessionId]?.result ?? { ok: true, queuePosition: null }
    },
  }
  return { port, received }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

/** The persisted "has seen how answering works" flag, shared across router instances (restarts). */
function fakeOnboardingFlag(seen = true) {
  const flag = { seen }
  return { seen: () => flag.seen, markSeen: () => (flag.seen = true) }
}

const ONBOARDING =
  '💡 Plain messages go to Home Agent. To talk to an agent, reply to its message (or tap 💬 Answer).'

function setup(
  sessions: Record<string, FakeSession> = { asteroids: { label: 'Asteroids clone' } },
  sentMessages = [{ kind: 'telegram' as ChannelKind, ref: '1234', sessionId: 'asteroids' }],
  onboarding = fakeOnboardingFlag(),
) {
  const questions = createChannelQuestionRegistry({ newId: () => 'q1', log: () => {} })
  const fake = fakeSessions(sessions, sentMessages)
  const router = createAnswerRouter({
    sessions: () => fake.port,
    questions,
    onboarding,
    log: () => {},
  })
  return { router, questions, received: fake.received }
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

  it('opens an Answer Prompt when the Answer button is tapped, and sends the reply to it', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { callback: 'answer', replyTo: '1234' })).toBe(true)
    expect(ch.prompts).toEqual([
      { text: 'Your message to "Asteroids clone":', placeholder: 'Message to "Asteroids clone"' },
    ])
    expect(received).toEqual([])

    expect(await router.route(ch.adapter, { text: 'faster ship', replyTo: '901' })).toBe(true)
    expect(received).toEqual([{ sessionId: 'asteroids', text: 'faster ship' }])
    expect(ch.replies).toEqual(['➡️ Sent to "Asteroids clone" — starting…'])
  })

  it('keeps the Answer Prompt placeholder within Telegram’s 64 characters', async () => {
    const { router } = setup({ asteroids: { label: 'A'.repeat(80) } })
    const ch = fakeChannel()
    await router.route(ch.adapter, { callback: 'answer', replyTo: '1234' })
    expect([...ch.prompts[0].placeholder]).toHaveLength(64)
    expect(ch.prompts[0].placeholder.endsWith('…')).toBe(true)
  })

  it('says the session no longer exists when Answer is tapped under a deleted session’s message', async () => {
    const { router, received } = setup()
    const ch = fakeChannel()
    expect(await router.route(ch.adapter, { callback: 'answer', replyTo: '77' })).toBe(true)
    expect(ch.prompts).toEqual([])
    expect(ch.replies).toEqual(['⚠️ That session no longer exists'])
    expect(received).toEqual([])
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

  it('explains how answering works after the very first Answer, and never again', async () => {
    const flag = fakeOnboardingFlag(false)
    const first = setup(undefined, undefined, flag)
    const ch = fakeChannel()
    await first.router.route(ch.adapter, { text: 'try a smaller level', replyTo: '1234' })
    await first.router.route(ch.adapter, { text: 'and faster', replyTo: '1234' })
    const afterRestart = setup(undefined, undefined, flag)
    await afterRestart.router.route(ch.adapter, { text: 'once more', replyTo: '1234' })
    expect(ch.replies).toEqual([
      '➡️ Sent to "Asteroids clone" — starting…',
      ONBOARDING,
      '➡️ Sent to "Asteroids clone" — starting…',
      '➡️ Sent to "Asteroids clone" — starting…',
    ])
  })

  it('does not explain answering to a plain message for Home Agent', async () => {
    const { router } = setup(undefined, undefined, fakeOnboardingFlag(false))
    const ch = fakeChannel()
    await router.route(ch.adapter, { text: 'what is the weather?' })
    expect(ch.replies).toEqual([])
  })
})
