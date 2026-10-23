import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChannelQuestionRegistry } from '../../../src/assets/js/store/channels/channelQuestions'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type { ChannelKind, KeyboardButton } from '../../../src/assets/js/store/channels/types'

type Sent = { text: string; buttons: KeyboardButton[][]; messageId: number }

function fakeChannel(kind: ChannelKind = 'local-web') {
  const prompts: Sent[] = []
  const edits: { messageId: number; text: string }[] = []
  const replies: string[] = []
  const adapter = {
    kind,
    formatMarkdown: (md: string) => md,
    formatRichSnippet: (html: string) => html,
    keyboard: async (text: string, buttons: KeyboardButton[][]) => {
      const messageId = prompts.length + 1
      prompts.push({ text, buttons, messageId })
      return { ok: true, ref: { messageId } }
    },
    editKeyboardMessage: async (ref: { messageId?: number }, text: string) => {
      edits.push({ messageId: ref.messageId!, text })
      return { ok: true }
    },
    reply: async (text: string) => {
      replies.push(text)
      return { ok: true }
    },
  } as unknown as ChannelAdapter
  const tap = (prompt: Sent, label: 'Confirm' | 'Cancel') =>
    prompt.buttons.flat().find((b) => b.text.includes(label))!.callbackData
  return { adapter, prompts, edits, replies, tap }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

let ids = 0
const registry = () => createChannelQuestionRegistry({ newId: () => `q${++ids}`, log: () => {} })

afterEach(() => vi.useRealTimers())

describe('channel question registry', () => {
  it('settles two open questions on one channel independently by their own buttons', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const first = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download A?' })
    const second = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download B?' })
    await flush()
    expect(ch.prompts).toHaveLength(2)

    expect(reg.handleInbound(ch.adapter, { callback: ch.tap(ch.prompts[1], 'Confirm') })).toBe(true)
    await expect(second.answer).resolves.toBe(true)
    expect(reg.isOpen(first.id)).toBe(true)
    expect(ch.edits).toEqual([{ messageId: 2, text: 'Download B?\n\n✅ Confirmed.' }])

    expect(reg.handleInbound(ch.adapter, { callback: ch.tap(ch.prompts[0], 'Cancel') })).toBe(true)
    await expect(first.answer).resolves.toBe(false)
    expect(ch.edits[1]).toEqual({ messageId: 1, text: 'Download A?\n\n❌ Cancelled.' })
  })

  it('takes the buttons away from a question settled before its send landed', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const question = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download A?' })
    reg.settle(question.id, false, '✔ Answered in AI Playground.')
    await flush()
    expect(ch.prompts).toHaveLength(1)
    expect(ch.edits).toEqual([
      { messageId: 1, text: 'Download A?\n\n✔ Answered in AI Playground.' },
    ])
  })

  it('keeps callback data within Telegram’s 64-byte limit', async () => {
    const reg = createChannelQuestionRegistry({ log: () => {} })
    const ch = fakeChannel('telegram')
    reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?' })
    await flush()
    for (const b of ch.prompts[0].buttons.flat()) {
      expect(new TextEncoder().encode(b.callbackData).length).toBeLessThanOrEqual(64)
      expect(b.callbackData.startsWith('confirm:')).toBe(true)
    }
  })

  it('answers a tap on a question that is no longer open with a pointer to the app', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?' })
    await flush()
    const confirm = ch.tap(ch.prompts[0], 'Confirm')
    reg.handleInbound(ch.adapter, { callback: confirm })
    await q.answer
    expect(reg.handleInbound(ch.adapter, { callback: confirm })).toBe(true)
    // An id from before an app restart, and the pre-registry callback shape.
    expect(reg.handleInbound(ch.adapter, { callback: 'confirm:zz9:yes' })).toBe(true)
    expect(reg.handleInbound(ch.adapter, { callback: 'confirm:yes' })).toBe(true)
    await flush()
    expect(ch.replies).toHaveLength(3)
    for (const r of ch.replies) expect(r).toMatch(/no longer open.*AI Playground/)
  })

  it('leaves callbacks that are not confirmations to the Home Agent', () => {
    const reg = registry()
    const ch = fakeChannel()
    expect(reg.handleInbound(ch.adapter, { callback: 'imgGen:cancel' })).toBe(false)
    expect(ch.replies).toEqual([])
  })

  it('treats a tap arriving on another channel as no longer open there', async () => {
    const reg = registry()
    const telegram = fakeChannel('telegram')
    const slack = fakeChannel('slack')
    const q = reg.ask({ adapter: telegram.adapter, summaryMarkdown: 'Apply?' })
    await flush()
    const confirm = telegram.tap(telegram.prompts[0], 'Confirm')
    expect(reg.handleInbound(slack.adapter, { callback: confirm })).toBe(true)
    expect(reg.isOpen(q.id)).toBe(true)
    await flush()
    expect(slack.replies).toHaveLength(1)
  })

  it('lets a typed yes answer an in-turn confirmation', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?', typedReply: true })
    await flush()
    expect(reg.handleInbound(ch.adapter, { text: 'Yes!' })).toBe(true)
    await expect(q.answer).resolves.toBe(true)
  })

  it('declines an in-turn confirmation on unrelated text and lets the text through', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?', typedReply: true })
    await flush()
    expect(reg.handleInbound(ch.adapter, { text: 'what is the weather?' })).toBe(false)
    await expect(q.answer).resolves.toBe(false)
  })

  it('never answers a button-only question from typed text', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download?' })
    await flush()
    expect(reg.handleInbound(ch.adapter, { text: 'yes' })).toBe(false)
    expect(reg.isOpen(q.id)).toBe(true)
  })

  it('declines on timeout and edits the prompt in place', async () => {
    vi.useFakeTimers()
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({
      adapter: ch.adapter,
      summaryMarkdown: 'Apply?',
      typedReply: true,
      timeoutMs: 120_000,
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(q.answer).resolves.toBe(false)
    expect(ch.edits).toEqual([{ messageId: 1, text: 'Apply?\n\n⌛ No response — cancelled.' }])
  })

  it('notes a desktop answer in place and turns a later channel tap away', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?' })
    await flush()
    expect(reg.settle(q.id, true, '✅ Confirmed from the desktop app.')).toBe(true)
    await expect(q.answer).resolves.toBe(true)
    expect(ch.edits).toEqual([
      { messageId: 1, text: 'Apply?\n\n✅ Confirmed from the desktop app.' },
    ])
    expect(reg.settle(q.id, false)).toBe(false)
    expect(reg.handleInbound(ch.adapter, { callback: ch.tap(ch.prompts[0], 'Cancel') })).toBe(true)
    await flush()
    expect(ch.replies[0]).toMatch(/no longer open/)
  })

  it('keeps a Channel Question open while an in-turn confirmation takes a typed yes', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const channelQuestion = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download?' })
    const inTurn = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?', typedReply: true })
    await flush()
    expect(reg.handleInbound(ch.adapter, { text: 'yes' })).toBe(true)
    await expect(inTurn.answer).resolves.toBe(true)
    expect(reg.isOpen(channelQuestion.id)).toBe(true)

    expect(reg.handleInbound(ch.adapter, { callback: ch.tap(ch.prompts[0], 'Confirm') })).toBe(true)
    await expect(channelQuestion.answer).resolves.toBe(true)
  })

  it('lets unrelated text through and leaves every Channel Question open', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const first = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download A?' })
    const second = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download B?' })
    await flush()
    for (const text of ['no', 'cancel', 'what is the weather?']) {
      expect(reg.handleInbound(ch.adapter, { text })).toBe(false)
    }
    expect(reg.isOpen(first.id)).toBe(true)
    expect(reg.isOpen(second.id)).toBe(true)
    expect(ch.edits).toEqual([])
  })

  it('never times out a Channel Question', async () => {
    vi.useFakeTimers()
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download?' })
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)
    expect(reg.isOpen(q.id)).toBe(true)
    expect(ch.edits).toEqual([])
  })

  it('retires a question in place when its pause ends, without answering it', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download?' })
    await flush()
    let answered = false
    void q.answer.then(() => (answered = true))
    expect(reg.retire(q.id, '⏹ No longer needed.')).toBe(true)
    expect(ch.edits).toEqual([{ messageId: 1, text: 'Download?\n\n⏹ No longer needed.' }])
    expect(reg.retire(q.id, 'again')).toBe(false)
    expect(reg.handleInbound(ch.adapter, { callback: ch.tap(ch.prompts[0], 'Confirm') })).toBe(true)
    await flush()
    expect(ch.replies[0]).toMatch(/no longer open/)
    expect(answered).toBe(false)
  })

  it('retires Channel Questions asked on a channel that is no longer the Notification Channel', async () => {
    const reg = registry()
    const telegram = fakeChannel('telegram')
    const slack = fakeChannel('slack')
    const onTelegram = reg.ask({ adapter: telegram.adapter, summaryMarkdown: 'Download A?' })
    const onSlack = reg.ask({ adapter: slack.adapter, summaryMarkdown: 'Download B?' })
    const inTurn = reg.ask({
      adapter: telegram.adapter,
      summaryMarkdown: 'Apply?',
      typedReply: true,
    })
    await flush()
    reg.retireOutside('slack', '⏹ Not here.')
    expect(reg.isOpen(onTelegram.id)).toBe(false)
    expect(reg.isOpen(onSlack.id)).toBe(true)
    expect(reg.isOpen(inTurn.id)).toBe(true)
    expect(telegram.edits).toEqual([{ messageId: 1, text: 'Download A?\n\n⏹ Not here.' }])

    reg.retireOutside(null, '⏹ Closed.')
    expect(reg.isOpen(onSlack.id)).toBe(false)
    expect(reg.isOpen(inTurn.id)).toBe(true)
  })

  it('takes the buttons away from a question retired before its send landed', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download?' })
    reg.retireOutside(null, '⏹ Not here.')
    await flush()
    expect(ch.prompts).toHaveLength(1)
    expect(ch.edits).toEqual([{ messageId: 1, text: 'Download?\n\n⏹ Not here.' }])
    expect(reg.isOpen(q.id)).toBe(false)
  })
})
