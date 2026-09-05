import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { ChatToolResult } from '@/types/chatIpc'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => './tmp' },
}))

const {
  executeToolInRenderer,
  handleChatToolResult,
  abortTurnToolRequests,
  rejectAllChatToolRequests,
  resetChatToolBridgeForTest,
  chatToolRequestsPending,
  CHAT_TOOL_ABORTED,
} = await import('../../chat/toolBridge')

type SentPayload = ChatToolResult & Record<string, unknown>

function fakeWindow(): { win: BrowserWindow; sent: SentPayload[] } {
  const sent: SentPayload[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, payload: SentPayload) => void sent.push(payload) },
  } as unknown as BrowserWindow
  return { win, sent }
}

const { setKernelEventWindow, resetKernelBusForTest } = await import('../../kernel/kernelBus')

beforeEach(() => {
  resetKernelBusForTest()
  resetChatToolBridgeForTest()
})

describe('chat tool bridge', () => {
  it('round-trips a tool execution by requestId', async () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    const promise = executeToolInRenderer({
      conversationKey: 'conv-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'searchWeb',
      input: { query: 'cats' },
    })
    expect(sent).toHaveLength(1)
    expect(sent[0].toolName).toBe('searchWeb')
    expect(sent[0].input).toEqual({ query: 'cats' })
    expect(typeof sent[0].requestId).toBe('string')
    handleChatToolResult({ requestId: sent[0].requestId, output: { ok: true } })
    await expect(promise).resolves.toEqual({ ok: true })
  })

  it('rejects on a tool error', async () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    const promise = executeToolInRenderer({
      conversationKey: 'conv-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'searchWeb',
      input: {},
    })
    handleChatToolResult({ requestId: sent[0].requestId, error: 'engine offline' })
    await expect(promise).rejects.toThrow('engine offline')
  })

  it('aborts only the cancelled turn’s pending calls', async () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    const first = executeToolInRenderer({
      conversationKey: 'conv-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'a',
      input: {},
    })
    const second = executeToolInRenderer({
      conversationKey: 'conv-2',
      turnId: 'turn-2',
      toolCallId: 'call-2',
      toolName: 'b',
      input: {},
    })
    abortTurnToolRequests('turn-1')
    await expect(first).rejects.toThrow(CHAT_TOOL_ABORTED)
    handleChatToolResult({ requestId: sent[1].requestId, output: 'done' })
    await expect(second).resolves.toBe('done')
    expect(chatToolRequestsPending()).toBe(0)
  })

  it('marks a renderer-side abort result with the abort marker', async () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    const promise = executeToolInRenderer({
      conversationKey: 'conv-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'a',
      input: {},
    })
    handleChatToolResult({ requestId: sent[0].requestId, aborted: true })
    await expect(promise).rejects.toThrow(CHAT_TOOL_ABORTED)
  })

  it('rejects immediately without a live window', async () => {
    setKernelEventWindow(null)
    await expect(
      executeToolInRenderer({
        conversationKey: 'conv-1',
        turnId: 'turn-1',
        toolCallId: 'call-1',
        toolName: 'a',
        input: {},
      }),
    ).rejects.toThrow('No renderer window')
  })

  it('settles everything when the window is replaced', async () => {
    const { win } = fakeWindow()
    setKernelEventWindow(win)
    const promise = executeToolInRenderer({
      conversationKey: 'conv-1',
      turnId: 'turn-1',
      toolCallId: 'call-1',
      toolName: 'a',
      input: {},
    })
    rejectAllChatToolRequests('The app window was replaced')
    await expect(promise).rejects.toThrow('replaced')
    expect(chatToolRequestsPending()).toBe(0)
  })

  it('ignores results for unknown or duplicate request ids', () => {
    expect(() => {
      handleChatToolResult({ requestId: 'nope', output: 1 })
      handleChatToolResult({ requestId: 'nope', output: 1 })
    }).not.toThrow()
  })
})
