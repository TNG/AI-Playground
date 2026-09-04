import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { KernelEvent } from '@/types/kernelEvents'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => './tmp' },
}))

const {
  setKernelEventWindow,
  emitServiceUpdate,
  beginAgentTurnSnapshot,
  emitAgentChunk,
  emitAgentToolProgress,
  emitAgentToolImage,
  emitAgentTurnDone,
  getKernelSnapshot,
  resetKernelBusForTest,
} = await import('../../kernel/kernelBus')

function fakeWindow(): { win: BrowserWindow; sent: KernelEvent[] } {
  const sent: KernelEvent[] = []
  const win = {
    isDestroyed: () => false,
    webContents: { send: (_channel: string, event: KernelEvent) => void sent.push(event) },
  } as unknown as BrowserWindow
  return { win, sent }
}

beforeEach(() => {
  resetKernelBusForTest()
})

describe('kernel bus', () => {
  it('stamps every event with one strictly monotonic sequence', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    emitServiceUpdate({ serviceName: 'ai-backend', status: 'notYetStarted' })
    beginAgentTurnSnapshot('turn-1')
    emitAgentChunk('turn-1', { type: 'text-start' })
    emitAgentToolProgress('turn-1', 'call-1', 'browser', 'navigating')
    emitAgentToolImage('call-1', 'data:image/png;base64,', 'cover.png')
    emitAgentTurnDone('turn-1')
    const seqs = sent.map((event) => event.seq)
    expect(seqs).toEqual([1, 2, 3, 4, 5])
  })

  it('emits nothing and throws nothing without a live window', () => {
    emitServiceUpdate({ serviceName: 'ai-backend', status: 'notYetStarted' })
    expect(getKernelSnapshot().sequence).toBe(1)
  })

  it('survives a destroyed window', () => {
    setKernelEventWindow({ isDestroyed: () => true } as unknown as BrowserWindow)
    expect(() => emitServiceUpdate({ serviceName: 'ai-backend' })).not.toThrow()
  })

  it('records service info for the snapshot, keyed by serviceName', () => {
    emitServiceUpdate({ serviceName: 'ai-backend', status: 'notYetStarted' })
    emitServiceUpdate({ serviceName: 'ai-backend', status: 'running' })
    emitServiceUpdate({ serviceName: 'llamacpp-backend', status: 'running' })
    const snapshot = getKernelSnapshot()
    expect(snapshot.sequence).toBe(3)
    expect(snapshot.state.services).toEqual([
      { serviceName: 'ai-backend', status: 'running' },
      { serviceName: 'llamacpp-backend', status: 'running' },
    ])
  })

  it('ignores service payloads without a serviceName', () => {
    emitServiceUpdate({ status: 'running' })
    expect(getKernelSnapshot().state.services).toEqual([])
  })

  it('accumulates the active turn and clears it when the turn is done', () => {
    beginAgentTurnSnapshot('turn-1')
    emitAgentChunk('turn-1', { type: 'text-start' })
    emitAgentChunk('turn-1', { type: 'text-delta', id: 'a', delta: 'hello' })
    emitAgentToolProgress('turn-1', 'call-1', 'browser', 'navigating')
    emitAgentToolImage('call-1', 'data:image/png;base64,', 'cover.png')

    expect(getKernelSnapshot().state.activeTurn).toEqual({
      turnId: 'turn-1',
      chunks: [{ type: 'text-start' }, { type: 'text-delta', id: 'a', delta: 'hello' }],
      toolProgress: { 'call-1': 'navigating' },
      toolImages: {
        'call-1': [
          {
            type: 'agent-tool-image',
            toolCallId: 'call-1',
            dataUri: 'data:image/png;base64,',
            label: 'cover.png',
          },
        ],
      },
    })

    emitAgentTurnDone('turn-1')
    expect(getKernelSnapshot().state.activeTurn).toBeNull()
  })

  it('clears the accumulator synchronously with the done event, so the watermark stays sound', () => {
    const { win, sent } = fakeWindow()
    setKernelEventWindow(win)
    beginAgentTurnSnapshot('turn-1')
    emitAgentTurnDone('turn-1')
    // The done event is on the stream; a snapshot at this seq must not still
    // name the turn, or a reconnect would adopt a dead one.
    expect(sent.at(-1)?.type).toBe('agent-turn-done')
    expect(getKernelSnapshot().state.activeTurn).toBeNull()
  })

  it('ignores chunks and progress that belong to no active turn', () => {
    emitAgentChunk('turn-9', { type: 'text-start' })
    emitAgentToolProgress('turn-9', 'call-1', 'browser', 'x')
    emitAgentToolImage('call-9', 'data:image/png;base64,', 'orphan.png')
    const snapshot = getKernelSnapshot()
    expect(snapshot.state.activeTurn).toBeNull()
    expect(snapshot.sequence).toBe(3)
  })

  it('sends to the window set by setKernelEventWindow, not an older one', () => {
    const first = fakeWindow()
    const second = fakeWindow()
    setKernelEventWindow(first.win)
    setKernelEventWindow(second.win)
    emitServiceUpdate({ serviceName: 'ai-backend' })
    expect(first.sent).toHaveLength(0)
    expect(second.sent).toHaveLength(1)
  })
})
