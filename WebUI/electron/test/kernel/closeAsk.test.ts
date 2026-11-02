import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents } from 'electron'
import {
  askWindowToClose,
  handleCloseAnswer,
  handleCloseBridgeReady,
  showRefreshedCloseQuestion,
} from '../../kernel/closeAsk'
import { createCloseCoordinator } from '../../kernel/closeCoordinator'
import type { CloseAskPayload, CloseQuestion } from '@/types/lifecycleIpc'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn(), on: vi.fn() } }))

// The window can reload (Ctrl+R, a dev-server reconnect) while the close question is open.

function fakeWindow() {
  const sent: { channel: string; payload: unknown }[] = []
  const webContents = Object.assign(new EventEmitter(), {
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    isCrashed: () => false,
    isDestroyed: () => false,
  })
  const win = {
    webContents,
    isDestroyed: () => false,
    isMinimized: () => false,
    show: vi.fn(),
    focus: vi.fn(),
  }
  return {
    win: win as unknown as BrowserWindow,
    webContents: webContents as unknown as WebContents,
    sent,
    asked: () =>
      sent
        .filter((entry) => entry.channel === 'lifecycle:askClose')
        .map((e) => e.payload) as CloseAskPayload[],
  }
}

const question: CloseQuestion = {
  items: [{ kind: 'agent-turn', name: 'Asteroids', state: { status: 'running' } }],
  more: 0,
}

describe('a window reloaded while the close question is open', () => {
  it('asks the reloaded window again, with the latest list and the same question', async () => {
    const { win, webContents, sent, asked } = fakeWindow()
    const answer = askWindowToClose(win, question)
    const refreshed: CloseQuestion = { items: [], more: 0 }
    showRefreshedCloseQuestion(refreshed)
    sent.length = 0

    handleCloseBridgeReady(webContents)

    expect(sent.map((entry) => entry.channel)).toEqual([
      'lifecycle:holdSchedules',
      'lifecycle:askClose',
    ])
    expect(sent[0].payload).toBe(true)
    const [again] = asked()
    expect(again).toMatchObject(refreshed)

    handleCloseAnswer({ requestId: again.requestId, answer: 'quit' })
    await expect(answer).resolves.toBe('quit')
  })

  it('lets the next close quit once the reloaded window answers, instead of joining forever', async () => {
    const { win, webContents, asked } = fakeWindow()
    const quit = vi.fn()
    const coordinator = createCloseCoordinator({
      listInFlightWork: async () => question.items,
      askWindow: (q) => askWindowToClose(win, q),
      showRefreshedQuestion: showRefreshedCloseQuestion,
      whileAsking: () => () => {},
      quit,
      suspendSchedules: () => {},
      resumeSchedules: () => {},
    })
    const first = coordinator.requestClose()
    await vi.waitFor(() => expect(asked()).toHaveLength(1))

    handleCloseBridgeReady(webContents)
    const second = coordinator.requestClose()
    handleCloseAnswer({ requestId: asked()[1].requestId, answer: 'quit' })

    await expect(first).resolves.toBe('quit')
    await expect(second).resolves.toBe('quit')
    expect(quit).toHaveBeenCalledTimes(1)
  })

  it('asks nothing when no question is open', () => {
    const { webContents, sent } = fakeWindow()

    handleCloseBridgeReady(webContents)

    expect(sent).toEqual([])
  })

  it('asks nothing of another window', async () => {
    const asking = fakeWindow()
    const other = fakeWindow()
    const answer = askWindowToClose(asking.win, question)

    handleCloseBridgeReady(other.webContents)

    expect(other.sent).toEqual([])
    handleCloseAnswer({ requestId: asking.asked()[0].requestId, answer: 'keep' })
    await expect(answer).resolves.toBe('keep')
  })
})
