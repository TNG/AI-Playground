import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The renderer tool bridge gives up on a call the window never answers. While the
// session that made the call is waiting on the user (a download prompt it raised),
// that clock stops: a paused session waits without a deadline.

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => '/tmp' },
  BrowserWindow: { getAllWindows: () => [] },
  net: { fetch: () => Promise.reject(new Error('no network in tests')) },
}))

const MINUTE = 60_000

const tools = await import('../../agent/piCustomTools')
const userWait = await import('../../kernel/userWait')

const sent: Array<{ channel: string; payload: unknown }> = []

beforeEach(() => {
  vi.useFakeTimers()
  sent.length = 0
  tools.setToolBridgeWindow({
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => sent.push({ channel, payload }) },
  } as never)
})

afterEach(() => {
  tools.rejectPendingToolCalls('test over')
  vi.useRealTimers()
})

/** Opens a user wait for `sessionId`; the returned call answers it. */
function askUser(sessionId: string): () => void {
  let answer = () => {}
  void userWait.awaitUser(sessionId, () => new Promise<void>((resolve) => (answer = resolve)))
  return () => answer()
}

function settled(promise: Promise<unknown>) {
  const state: { error?: Error; done: boolean } = { done: false }
  promise.then(
    () => (state.done = true),
    (error: Error) => {
      state.done = true
      state.error = error
    },
  )
  return state
}

describe('the renderer tool bridge timeout', () => {
  it('still gives up on an unanswered call after 30 minutes', async () => {
    const call = settled(tools.executeToolInRenderer('s1', 'rag_prepare', {}, 'call-1'))
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(call.error?.message).toMatch(/timed out after 30min/)
  })

  it('does not count while the session waits on the user, and counts the rest after', async () => {
    const call = settled(tools.executeToolInRenderer('s1', 'rag_prepare', {}, 'call-1'))
    await vi.advanceTimersByTimeAsync(10 * MINUTE)

    const answer = askUser('s1')
    await vi.advanceTimersByTimeAsync(5 * 60 * MINUTE)
    expect(call.done).toBe(false)

    answer()
    await vi.advanceTimersByTimeAsync(20 * MINUTE - 1)
    expect(call.done).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(call.error?.message).toMatch(/timed out/)
  })

  it('keeps counting for a session that is not the one waiting', async () => {
    const call = settled(tools.executeToolInRenderer('s1', 'rag_prepare', {}, 'call-1'))
    const answer = askUser('s2')
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(call.error?.message).toMatch(/timed out/)
    answer()
  })

  it('does not start counting a call made while its session already waits', async () => {
    const answer = askUser('s1')
    const call = settled(tools.executeToolInRenderer('s1', 'rag_prepare', {}, 'call-1'))
    await vi.advanceTimersByTimeAsync(60 * MINUTE)
    expect(call.done).toBe(false)
    answer()
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(call.error?.message).toMatch(/timed out/)
  })
})
