import { describe, expect, it, vi } from 'vitest'
import {
  bindRendererWorkReset,
  createCloseCoordinator,
  type CloseAnswer,
} from '../../kernel/closeCoordinator'
import type { CloseQuestion, InFlightWorkItem } from '@/types/lifecycleIpc'

// Every way of closing the app goes through this one coordinator:
// nothing in flight quits, In-flight Work asks the window, and the answer decides.

function harness(initialWork: InFlightWorkItem[], answer: () => Promise<CloseAnswer>) {
  let work = initialWork
  const asked: CloseQuestion[] = []
  const shown: CloseQuestion[] = []
  const schedules: ('suspended' | 'resumed')[] = []
  const quit = vi.fn()
  const minimizeWindow = vi.fn()
  let refresh: (() => Promise<void>) | null = null
  const coordinator = createCloseCoordinator({
    listInFlightWork: async () => work,
    askWindow: (question) => {
      asked.push(question)
      return answer()
    },
    showRefreshedQuestion: (question) => shown.push(question),
    whileAsking: (tick) => {
      refresh = tick
      return () => {
        refresh = null
      }
    },
    quit,
    minimizeWindow,
    suspendSchedules: () => schedules.push('suspended'),
    resumeSchedules: () => schedules.push('resumed'),
  })
  /** Work changes while the question is open; the coordinator's next refresh sees it. */
  async function workBecomes(next: InFlightWorkItem[]) {
    work = next
    await refresh?.()
  }
  return { coordinator, asked, shown, schedules, quit, minimizeWindow, workBecomes }
}

function heldQuestion() {
  let answer: (value: CloseAnswer) => void = () => {}
  const pending = () => new Promise<CloseAnswer>((resolve) => (answer = resolve))
  return { pending, answer: (value: CloseAnswer) => answer(value) }
}

const agentRunning: InFlightWorkItem = {
  kind: 'agent-turn',
  name: 'Asteroids',
  state: { status: 'running' },
}

describe('close coordinator', () => {
  it('quits without asking when nothing is in flight', async () => {
    const { coordinator, asked, quit } = harness([], async () => 'keep')

    await expect(coordinator.requestClose()).resolves.toBe('quit')
    expect(asked).toEqual([])
    expect(quit).toHaveBeenCalledOnce()
  })

  it.each<[string, InFlightWorkItem]>([
    ['a running agent turn', agentRunning],
    [
      'an agent turn paused waiting for the user',
      { kind: 'agent-turn', name: 'Asteroids', state: { status: 'paused' } },
    ],
    ['a queued chat turn', { kind: 'chat-turn', name: 'Recipes', state: { status: 'queued' } }],
    [
      'an executing image run',
      { kind: 'media-run', mode: 'imageGen', state: { status: 'running' } },
    ],
    [
      'queued video runs',
      { kind: 'media-run', mode: 'video', state: { status: 'queued', count: 2 } },
    ],
  ])('asks the window, naming %s', async (_case, item) => {
    const { coordinator, asked } = harness([item], async () => 'keep')

    await coordinator.requestClose()

    expect(asked).toEqual([{ items: [item], more: 0 }])
  })

  it('Keep open cancels the close', async () => {
    const { coordinator, quit } = harness([agentRunning], async () => 'keep')

    await expect(coordinator.requestClose()).resolves.toBe('kept-open')
    expect(quit).not.toHaveBeenCalled()
  })

  it('Minimize keeps the app open, resumes Schedules and minimizes the window', async () => {
    const { coordinator, quit, minimizeWindow, schedules } = harness(
      [agentRunning],
      async () => 'minimize',
    )

    await expect(coordinator.requestClose()).resolves.toBe('kept-open')
    expect(quit).not.toHaveBeenCalled()
    expect(minimizeWindow).toHaveBeenCalledOnce()
    expect(schedules).toEqual(['suspended', 'resumed'])
  })

  it('Keep open does not minimize the window', async () => {
    const { coordinator, minimizeWindow } = harness([agentRunning], async () => 'keep')

    await coordinator.requestClose()

    expect(minimizeWindow).not.toHaveBeenCalled()
  })

  it('Quit runs the shutdown', async () => {
    const { coordinator, quit } = harness([agentRunning], async () => 'quit')

    await expect(coordinator.requestClose()).resolves.toBe('quit')
    expect(quit).toHaveBeenCalledOnce()
  })

  it('quits when there is no window to ask', async () => {
    const { coordinator, quit } = harness([agentRunning], async () => 'no-window')

    await expect(coordinator.requestClose()).resolves.toBe('quit')
    expect(quit).toHaveBeenCalledOnce()
  })

  it('quits when asking the window fails', async () => {
    const { coordinator, quit } = harness([agentRunning], () =>
      Promise.reject(new Error('Render frame was disposed')),
    )

    await expect(coordinator.requestClose()).resolves.toBe('quit')
    expect(quit).toHaveBeenCalledOnce()
  })

  it('a second close while the question is open joins it instead of asking again', async () => {
    let answer: (value: CloseAnswer) => void = () => {}
    const { coordinator, asked, quit } = harness(
      [agentRunning],
      () => new Promise<CloseAnswer>((resolve) => (answer = resolve)),
    )

    const first = coordinator.requestClose()
    const second = coordinator.requestClose()
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    answer('quit')

    await expect(Promise.all([first, second])).resolves.toEqual(['quit', 'quit'])
    expect(asked).toHaveLength(1)
    expect(quit).toHaveBeenCalledOnce()
  })

  it('asks again on the next close after Keep open', async () => {
    const { coordinator, asked } = harness([agentRunning], async () => 'keep')

    await coordinator.requestClose()
    await coordinator.requestClose()

    expect(asked).toHaveLength(2)
  })

  it('suspends Schedules while asking and resumes them on Keep open', async () => {
    const question = heldQuestion()
    const { coordinator, asked, schedules } = harness([agentRunning], question.pending)

    const outcome = coordinator.requestClose()
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    expect(schedules).toEqual(['suspended'])
    question.answer('keep')

    await expect(outcome).resolves.toBe('kept-open')
    expect(schedules).toEqual(['suspended', 'resumed'])
  })

  it('leaves Schedules suspended when the answer is Quit', async () => {
    const { coordinator, schedules } = harness([agentRunning], async () => 'quit')

    await coordinator.requestClose()

    expect(schedules).toEqual(['suspended'])
  })

  it('does not touch Schedules when nothing is in flight', async () => {
    const { coordinator, schedules } = harness([], async () => 'keep')

    await coordinator.requestClose()

    expect(schedules).toEqual([])
  })

  it('shows the refreshed list while the question is open', async () => {
    const question = heldQuestion()
    const chatRunning: InFlightWorkItem = {
      kind: 'chat-turn',
      name: 'Recipes',
      state: { status: 'running' },
    }
    const { coordinator, asked, shown, workBecomes } = harness(
      [agentRunning, chatRunning],
      question.pending,
    )

    const outcome = coordinator.requestClose()
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    await workBecomes([chatRunning])
    await workBecomes([chatRunning])

    expect(shown).toEqual([{ items: [chatRunning], more: 0 }])
    question.answer('keep')
    await outcome
  })

  it('an emptied list does not answer for the user', async () => {
    const question = heldQuestion()
    const { coordinator, asked, shown, quit, workBecomes } = harness(
      [agentRunning],
      question.pending,
    )

    let settled = false
    const outcome = coordinator.requestClose().finally(() => (settled = true))
    await vi.waitFor(() => expect(asked).toHaveLength(1))
    await workBecomes([])
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(shown).toEqual([{ items: [], more: 0 }])
    expect(settled).toBe(false)
    expect(quit).not.toHaveBeenCalled()
    question.answer('keep')
    await expect(outcome).resolves.toBe('kept-open')
  })

  it('stops refreshing once answered', async () => {
    const { coordinator, shown, workBecomes } = harness([agentRunning], async () => 'keep')

    await coordinator.requestClose()
    await workBecomes([])

    expect(shown).toEqual([])
  })

  it('shows five items and counts the rest', async () => {
    const work = Array.from({ length: 7 }, (_, index): InFlightWorkItem => ({
      kind: 'chat-turn',
      name: `Thread ${index + 1}`,
      state: { status: 'queued' },
    }))
    const { coordinator, asked } = harness(work, async () => 'keep')

    await coordinator.requestClose()

    expect(asked[0].items.map((item) => ('name' in item ? item.name : undefined))).toEqual([
      'Thread 1',
      'Thread 2',
      'Thread 3',
      'Thread 4',
      'Thread 5',
    ])
    expect(asked[0].more).toBe(2)
  })
})

describe('bindRendererWorkReset', () => {
  it("clears the window's report when the webContents is destroyed", () => {
    const listeners = new Map<string, () => void>()
    const webContents = {
      once: (event: 'destroyed', listener: () => void) => {
        listeners.set(event, listener)
      },
    }
    const setWork = vi.fn()
    bindRendererWorkReset(webContents, setWork)
    listeners.get('destroyed')?.()
    expect(setWork).toHaveBeenCalledWith([])
  })
})
