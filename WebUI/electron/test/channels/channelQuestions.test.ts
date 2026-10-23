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

    expect(reg.handleInbound('local-web', { callback: ch.tap(ch.prompts[1], 'Confirm') })).toBe(
      true,
    )
    await expect(second.answer).resolves.toBe(true)
    expect(reg.isOpen(first.id)).toBe(true)
    expect(ch.edits).toEqual([{ messageId: 2, text: 'Download B?\n\n✅ Confirmed.' }])

    expect(reg.handleInbound('local-web', { callback: ch.tap(ch.prompts[0], 'Cancel') })).toBe(true)
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

  it('passes a tap for a question that is not open through untouched', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?' })
    await flush()
    const confirm = ch.tap(ch.prompts[0], 'Confirm')
    reg.handleInbound('local-web', { callback: confirm })
    await q.answer
    expect(reg.handleInbound('local-web', { callback: confirm })).toBe(false)
    expect(reg.handleInbound('local-web', { callback: 'confirm:yes' })).toBe(false)
  })

  it('ignores a tap from a different channel', async () => {
    const reg = registry()
    const ch = fakeChannel('telegram')
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?' })
    await flush()
    expect(reg.handleInbound('slack', { callback: ch.tap(ch.prompts[0], 'Confirm') })).toBe(false)
    expect(reg.isOpen(q.id)).toBe(true)
  })

  it('lets a typed yes answer an in-turn confirmation', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?', typedReply: true })
    await flush()
    expect(reg.handleInbound('local-web', { text: 'Yes!' })).toBe(true)
    await expect(q.answer).resolves.toBe(true)
  })

  it('declines an in-turn confirmation on unrelated text and lets the text through', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Apply?', typedReply: true })
    await flush()
    expect(reg.handleInbound('local-web', { text: 'what is the weather?' })).toBe(false)
    await expect(q.answer).resolves.toBe(false)
  })

  it('never answers a button-only question from typed text', async () => {
    const reg = registry()
    const ch = fakeChannel()
    const q = reg.ask({ adapter: ch.adapter, summaryMarkdown: 'Download?' })
    await flush()
    expect(reg.handleInbound('local-web', { text: 'yes' })).toBe(false)
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

  it('notes a desktop answer in place and ignores a later channel tap', async () => {
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
    expect(reg.handleInbound('local-web', { callback: ch.tap(ch.prompts[0], 'Cancel') })).toBe(
      false,
    )
  })
})
