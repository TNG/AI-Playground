import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const queueEvents: Array<Record<string, unknown>> = []
vi.mock('../../kernel/kernelBus', () => ({
  emitQueueEvent: (event: Record<string, unknown>) => {
    queueEvents.push(event)
  },
}))

// The orchestrator sits on the runner's execution seam; here the runner is a
// controllable stub so the tests own when "the run" settles.
const startArtifactRunMock = vi.fn<(payload: { runId: string }) => Promise<unknown>>()
let activeRunId: string | null = null
const cancelActiveMock = vi.fn()
vi.mock('../../artifact/runner', () => ({
  artifactRunActive: () => activeRunId !== null,
  cancelActiveArtifactRun: () => cancelActiveMock(),
  activeArtifactRunId: () => activeRunId,
  startArtifactRun: (payload: { runId: string }) => startArtifactRunMock(payload),
}))

import {
  artifactRunsQueued,
  awaitChatWindow,
  cancelArtifactRun,
  resetOrchestratorForTest,
  runMediaRequest,
  setOrchestratorDeps,
  submitArtifactRun,
  type OrchestratorDeps,
} from '../../orchestrator/orchestrator'
import type { ArtifactRunPayload } from '../../artifact/runner'

type Deferred = {
  resolve: (value: unknown) => void
  promise: Promise<unknown>
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  const promise = new Promise<unknown>((res) => {
    resolve = res
  })
  return { resolve, promise }
}

function payload(overrides: Partial<ArtifactRunPayload> = {}): ArtifactRunPayload {
  return {
    runId: 'run-1',
    mode: 'imageGen',
    preset: { name: 'Draft Image' } as ArtifactRunPayload['preset'],
    params: {
      prompt: 'a castle',
      negativePrompt: '',
      seed: 1,
      inferenceSteps: 4,
      width: 512,
      height: 512,
      batchSize: 1,
    },
    inputs: [],
    ...overrides,
  } as ArtifactRunPayload
}

/**
 * Arms the runner stub so the NEXT submitted run holds the active slot until
 * the returned deferred resolves.
 */
function holdNextRun(): Deferred {
  const hold = deferred()
  startArtifactRunMock.mockImplementationOnce(async (request) => {
    activeRunId = request.runId
    const result = await hold.promise
    if (activeRunId === request.runId) activeRunId = null
    return result
  })
  return hold
}

const deps = (overrides: Partial<OrchestratorDeps> = {}): OrchestratorDeps => ({
  stopChatForMedia: vi.fn(async () => {}),
  freeComfyMemory: vi.fn(async () => {}),
  restartChatBackend: vi.fn(async () => {}),
  chatRequestsOpen: () => 0,
  ...overrides,
})

describe('the orchestrator', () => {
  beforeEach(() => {
    // reset, not clear: a test that cancels a queued run leaves its armed
    // once-implementation unconsumed, and the next test's run would inherit
    // a hold it can never resolve.
    vi.resetAllMocks()
    queueEvents.length = 0
    activeRunId = null
    resetOrchestratorForTest()
  })

  it('fail-fast refuses while anything is executing or queued; queue submissions park FIFO', async () => {
    setOrchestratorDeps(deps())
    const holdOne = holdNextRun()
    const active = submitArtifactRun(payload())
    // The runner stub marks the active slot when its async body runs; real
    // runs are synchronous at that point, here the slot is awaited.
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))

    const refused = await submitArtifactRun(payload({ runId: 'run-2' }))
    expect(refused.state).toBe('failed')
    expect(refused.error).toBe('Another generation is already in progress')

    const holdTwo = holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-3' }), { queue: 'queue' })
    expect(artifactRunsQueued()).toBe(1)
    expect((await submitArtifactRun(payload({ runId: 'run-4' }))).state).toBe('failed')

    holdOne.resolve({ state: 'completed', items: [] })
    await active
    await vi.waitFor(() => expect(activeRunId).toBe('run-3'))
    holdTwo.resolve({ state: 'completed', items: [] })
    expect((await queued).state).toBe('completed')
  })

  it('emits queue events in enqueue → start → finish order, carrying the chat scope', async () => {
    setOrchestratorDeps(deps())
    const holdOne = holdNextRun()
    const active = submitArtifactRun(payload({ conversationKey: 'c1', activityId: 'act-1' }))
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))
    const queued = submitArtifactRun(
      payload({ runId: 'run-2', conversationKey: 'c1', activityId: 'act-2' }),
      { queue: 'queue' },
    )

    expect(queueEvents.find((e) => e.action === 'enqueued')).toMatchObject({
      runKey: 'run-2',
      kind: 'artifact',
      queueDepth: 0,
      conversationKey: 'c1',
      activityId: 'act-2',
    })

    holdOne.resolve({ state: 'completed', items: [] })
    await active
    await queued
    expect(queueEvents.map((e) => `${e.runKey}:${e.action}`)).toEqual([
      'run-1:started',
      'run-2:enqueued',
      'run-1:finished',
      'run-2:started',
      'run-2:finished',
    ])
  })

  it('brackets the GPU window: one stop per drain, free + reload once on the last run out', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const holdOne = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())
    expect(activeRunId).toBe('run-1')

    const holdTwo = holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-2' }), { queue: 'queue' })

    // The head settles with work queued behind: no swap-back.
    holdOne.resolve({ state: 'completed', items: [] })
    await active
    expect(d.freeComfyMemory).not.toHaveBeenCalled()
    expect(d.restartChatBackend).not.toHaveBeenCalled()

    // The queued run takes the window without a second stop…
    await vi.waitFor(() => expect(activeRunId).toBe('run-2'))
    expect(d.stopChatForMedia).toHaveBeenCalledTimes(1)

    // …and the last one out swaps back exactly once.
    holdTwo.resolve({ state: 'completed', items: [] })
    await queued
    expect(d.stopChatForMedia).toHaveBeenCalledTimes(1)
    expect(d.freeComfyMemory).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })

  it('never swaps when keepModelsLoaded is set', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload({ keepModelsLoaded: true }))
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))
    hold.resolve({ state: 'completed', items: [] })
    await active
    expect(d.stopChatForMedia).not.toHaveBeenCalled()
    expect(d.freeComfyMemory).not.toHaveBeenCalled()
    expect(d.restartChatBackend).not.toHaveBeenCalled()
  })

  it('waits for open chat requests before stopping the backend', async () => {
    let openRequests = 2
    const d = deps({ chatRequestsOpen: () => openRequests })
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(d.stopChatForMedia).not.toHaveBeenCalled()
    openRequests = 0
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalledTimes(1))
    hold.resolve({ state: 'completed', items: [] })
    await active
  })

  it('chat readiness waits for the GPU window to come back to chat', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    let settled = false
    const readiness = awaitChatWindow().then(() => {
      settled = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)

    hold.resolve({ state: 'completed', items: [] })
    await active
    await readiness
    expect(settled).toBe(true)
  })

  it('cancels a queued run by id without touching the active one', async () => {
    setOrchestratorDeps(deps())
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))

    holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-2' }), { queue: 'queue' })
    cancelArtifactRun('run-2')
    expect((await queued).state).toBe('cancelled')
    expect(cancelActiveMock).not.toHaveBeenCalled()
    expect(activeRunId).toBe('run-1')
    hold.resolve({ state: 'completed', items: [] })
    await active
  })

  it('serializes media requests, and waits for the GPU window before starting one', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    const firstBracket = deferred()
    const bracketStarted: string[] = []
    const request1 = runMediaRequest(
      async () => {
        bracketStarted.push('one')
        return (await firstBracket.promise) as never
      },
      { runKey: 'media-1' },
    )

    await new Promise((resolve) => setTimeout(resolve, 20))
    // The window is held for media — the bracket must not start.
    expect(bracketStarted).toEqual([])

    const secondBracket = deferred()
    const request2 = runMediaRequest(
      async () => {
        bracketStarted.push('two')
        return (await secondBracket.promise) as never
      },
      { runKey: 'media-2' },
    )

    hold.resolve({ state: 'completed', items: [] })
    await active
    // The window came back (release ran); the first bracket may start.
    await vi.waitFor(() => expect(bracketStarted).toEqual(['one']))

    firstBracket.resolve('done-one')
    expect(await request1).toBe('done-one')
    await vi.waitFor(() => expect(bracketStarted).toEqual(['one', 'two']))
    secondBracket.resolve('done-two')
    expect(await request2).toBe('done-two')
  })

  it('a media request aborted while waiting never runs', async () => {
    setOrchestratorDeps(deps())
    const controller = new AbortController()
    controller.abort()
    await expect(
      runMediaRequest(async () => 'ran', {
        runKey: 'media-1',
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow('Cancelled while waiting')
  })
})
