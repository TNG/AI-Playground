import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const queueEvents: Array<Record<string, unknown>> = []
const phaseEvents: Array<{ tag: Record<string, unknown>; phase: string }> = []
vi.mock('../../kernel/kernelBus', () => ({
  emitQueueEvent: (event: Record<string, unknown>) => {
    queueEvents.push(event)
  },
  emitArtifactPhase: (tag: Record<string, unknown>, phase: string) => {
    phaseEvents.push({ tag, phase })
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
  artifactRunTag: (payload: { runId: string; owner?: unknown }) => ({
    runId: payload.runId,
    owner: payload.owner,
  }),
  startArtifactRun: (payload: { runId: string }) => startArtifactRunMock(payload),
  prepareRunModels: (payload: { runId: string }, onAsk: () => void) =>
    prepareRunModelsMock(payload, onAsk),
}))

// A member run's model pre-flight; unless a test arms it, nothing is missing.
const prepareRunModelsMock =
  vi.fn<(payload: { runId: string }, onAsk: () => void) => Promise<unknown>>()

import {
  artifactRunsQueued,
  artifactWorkOpen,
  awaitChatWindow,
  beginUserWait,
  cancelArtifactRun,
  cancelAllArtifactRuns,
  finishTextRequest,
  mediaRequestsQueued,
  reclaimTurnPlace,
  resetOrchestratorForTest,
  runMediaRequest,
  setOrchestratorDeps,
  submitArtifactRun,
  submitTextRequest,
  textRequestsOpen,
  type OrchestratorDeps,
  type TurnPause,
} from '../../kernel/orchestrator'
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
    prepareRunModelsMock.mockResolvedValue({ state: 'ready' })
    queueEvents.length = 0
    phaseEvents.length = 0
    activeRunId = null
    resetOrchestratorForTest()
  })

  it('announces a parked run as queued to its owner, and as cancelled when dropped', async () => {
    setOrchestratorDeps(deps())
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))

    const owner = { kind: 'tool' as const, toolCallId: 'call-2' }
    const queued = submitArtifactRun(payload({ runId: 'run-2', owner }), { queue: 'queue' })
    expect(phaseEvents).toEqual([{ tag: { runId: 'run-2', owner }, phase: 'queued' }])

    cancelArtifactRun('run-2')
    expect((await queued).state).toBe('cancelled')
    expect(phaseEvents.at(-1)).toEqual({ tag: { runId: 'run-2', owner }, phase: 'cancelled' })

    hold.resolve({ state: 'completed', items: [] })
    await active
  })

  it('queue submissions park FIFO behind the active run', async () => {
    setOrchestratorDeps(deps())
    const holdOne = holdNextRun()
    const active = submitArtifactRun(payload())
    // The runner stub marks the active slot when its async body runs; real
    // runs are synchronous at that point, here the slot is awaited.
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))

    const holdTwo = holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-3' }), { queue: 'queue' })
    expect(artifactRunsQueued()).toBe(1)

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

  it('does not admit a GPU chat turn while stopChatForMedia is in flight', async () => {
    const stop = deferred()
    const d = deps({ stopChatForMedia: vi.fn(() => stop.promise as Promise<void>) })
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const media = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    let admitted = false
    const text = submitTextRequest({
      runId: 'turn-1',
      conversationKey: 'c1',
      needsGpu: true,
    }).then(() => {
      admitted = true
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(admitted).toBe(false)
    expect(textRequestsOpen()).toBe(1)

    stop.resolve(undefined)
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))
    expect(admitted).toBe(false)

    hold.resolve({ state: 'completed', items: [] })
    await media
    await text
    expect(admitted).toBe(true)
  })

  it('returns the GPU after a failed run', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())
    hold.resolve({ state: 'failed', items: [], error: 'boom' })
    await active
    expect(d.freeComfyMemory).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })

  it('abandons queued and in-acquire artifact work', async () => {
    const stop = deferred()
    const d = deps({ stopChatForMedia: vi.fn(() => stop.promise as Promise<void>) })
    setOrchestratorDeps(d)
    holdNextRun()
    const acquiring = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())
    const queued = submitArtifactRun(payload({ runId: 'run-2' }), { queue: 'queue' })
    expect(artifactWorkOpen()).toBe(true)
    expect(artifactRunsQueued()).toBe(1)

    cancelAllArtifactRuns('The app window was replaced')
    expect((await queued).state).toBe('cancelled')
    expect(artifactRunsQueued()).toBe(0)

    stop.resolve(undefined)
    expect((await acquiring).state).toBe('cancelled')
    expect(activeRunId).toBe(null)
    await vi.waitFor(() => expect(d.restartChatBackend).toHaveBeenCalledTimes(1))
    expect(artifactWorkOpen()).toBe(false)
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

  it('still returns the GPU after a keepModelsLoaded tail that followed a swap', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const holdOne = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalledTimes(1))

    const holdTwo = holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-2', keepModelsLoaded: true }), {
      queue: 'queue',
    })
    holdOne.resolve({ state: 'completed', items: [] })
    await active
    expect(d.freeComfyMemory).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(activeRunId).toBe('run-2'))

    holdTwo.resolve({ state: 'completed', items: [] })
    await queued
    expect(d.freeComfyMemory).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })

  it('a second panel submit in the same tick waits for the first instead of cancelling it', async () => {
    setOrchestratorDeps(deps())
    const holdOne = holdNextRun()
    const first = submitArtifactRun(payload({ runId: 'run-1' }))
    const holdTwo = holdNextRun()
    const second = submitArtifactRun(payload({ runId: 'run-2' }))
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))
    expect(cancelActiveMock).not.toHaveBeenCalled()

    holdOne.resolve({ state: 'completed', items: [] })
    expect((await first).state).toBe('completed')
    await vi.waitFor(() => expect(activeRunId).toBe('run-2'))
    holdTwo.resolve({ state: 'completed', items: [] })
    expect((await second).state).toBe('completed')
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

  it('rejects awaitChatWindow as soon as the signal aborts, not on the next poll', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    const ac = new AbortController()
    const waiting = awaitChatWindow(ac.signal)
    const started = Date.now()
    ac.abort()
    await expect(waiting).rejects.toThrow('Cancelled while waiting for the chat GPU window.')
    expect(Date.now() - started).toBeLessThan(200)

    hold.resolve({ state: 'completed', items: [] })
    await active
  })

  it('cancels a queued run by id without touching the active one', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(activeRunId).toBe('run-1'))

    holdNextRun()
    const queued = submitArtifactRun(payload({ runId: 'run-2', activityId: 'act-2' }), {
      queue: 'queue',
    })
    cancelArtifactRun('run-2')
    expect((await queued).state).toBe('cancelled')
    expect(cancelActiveMock).not.toHaveBeenCalled()
    expect(activeRunId).toBe('run-1')
    expect(queueEvents.filter((e) => e.runKey === 'run-2').map((e) => e.action)).toEqual([
      'enqueued',
      'finished',
    ])
    hold.resolve({ state: 'completed', items: [] })
    await active
    expect(d.freeComfyMemory).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
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

  it('aborts a parked media request without waiting for the head', async () => {
    setOrchestratorDeps(deps())
    const first = deferred()
    const ran: string[] = []
    const request1 = runMediaRequest(
      async () => {
        ran.push('one')
        return (await first.promise) as never
      },
      { runKey: 'media-1' },
    )
    await vi.waitFor(() => expect(ran).toEqual(['one']))

    const controller = new AbortController()
    const request2 = runMediaRequest(
      async () => {
        ran.push('two')
        return 'nope'
      },
      { runKey: 'media-2', abortSignal: controller.signal },
    )
    expect(mediaRequestsQueued()).toBe(1)
    controller.abort()
    await expect(request2).rejects.toThrow('Cancelled while waiting')
    expect(mediaRequestsQueued()).toBe(0)
    expect(ran).toEqual(['one'])
    first.resolve('done')
    expect(await request1).toBe('done')
    expect(ran).toEqual(['one'])
  })

  it('cloud chat occupancy does not hold up a panel run', async () => {
    setOrchestratorDeps(deps())
    await submitTextRequest({ runId: 'cloud-1', conversationKey: 'c1', needsGpu: false })
    const hold = holdNextRun()
    const active = submitArtifactRun(payload({ runId: 'panel-1' }))
    await vi.waitFor(() => expect(activeRunId).toBe('panel-1'))
    hold.resolve({ state: 'completed', items: [] })
    expect((await active).state).toBe('completed')
    finishTextRequest('cloud-1')
  })

  it('nested queued media for the same conversation runs while text occupancy is live', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    await submitTextRequest({ runId: 'turn-1', conversationKey: 'c1', needsGpu: true })
    const hold = holdNextRun()
    const nested = submitArtifactRun(payload({ runId: 'nested-1', conversationKey: 'c1' }), {
      queue: 'queue',
    })
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalledTimes(1))
    expect(activeRunId).toBe('nested-1')
    expect(textRequestsOpen()).toBe(1)
    hold.resolve({ state: 'completed', items: [] })
    expect((await nested).state).toBe('completed')
    finishTextRequest('turn-1')
  })

  it('queued media for another conversation waits until unrelated text occupancy ends', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    await submitTextRequest({ runId: 'turn-1', conversationKey: 'c1', needsGpu: true })
    const hold = holdNextRun()
    const other = submitArtifactRun(payload({ runId: 'other-1', conversationKey: 'c2' }), {
      queue: 'queue',
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(d.stopChatForMedia).not.toHaveBeenCalled()
    expect(activeRunId).toBeNull()

    finishTextRequest('turn-1')
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalledTimes(1))
    expect(activeRunId).toBe('other-1')
    hold.resolve({ state: 'completed', items: [] })
    expect((await other).state).toBe('completed')
  })

  it('emits text queue events enqueued → started → finished', async () => {
    setOrchestratorDeps(deps())
    const admitted = submitTextRequest({ runId: 'turn-1', conversationKey: 'c1', needsGpu: true })
    await admitted
    expect(queueEvents.map((e) => `${e.kind}:${e.runKey}:${e.action}`)).toEqual([
      'text:turn-1:enqueued',
      'text:turn-1:started',
    ])
    finishTextRequest('turn-1')
    expect(queueEvents.at(-1)).toMatchObject({
      kind: 'text',
      runKey: 'turn-1',
      action: 'finished',
      conversationKey: 'c1',
    })
    expect(textRequestsOpen()).toBe(0)
  })

  it('a local text request waits for the GPU window and aborts without proceeding', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const active = submitArtifactRun(payload())
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalled())

    const ac = new AbortController()
    const waiting = submitTextRequest(
      { runId: 'turn-1', conversationKey: 'c1', needsGpu: true },
      ac.signal,
    )
    await vi.waitFor(() =>
      expect(queueEvents.some((e) => e.kind === 'text' && e.action === 'enqueued')).toBe(true),
    )
    expect(queueEvents.some((e) => e.kind === 'text' && e.action === 'started')).toBe(false)
    ac.abort()
    await expect(waiting).rejects.toThrow('Cancelled while waiting for the chat GPU window.')
    expect(textRequestsOpen()).toBe(0)
    expect(queueEvents.filter((e) => e.kind === 'text').map((e) => e.action)).toEqual([
      'enqueued',
      'finished',
    ])

    hold.resolve({ state: 'completed', items: [] })
    await active
  })
})

describe('the Turn Queue', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    prepareRunModelsMock.mockResolvedValue({ state: 'ready' })
    queueEvents.length = 0
    phaseEvents.length = 0
    activeRunId = null
    resetOrchestratorForTest()
  })

  function member(runId: string, conversationKey: string, needsGpu = true, signal?: AbortSignal) {
    const started: string[] = []
    const admitted = submitTextRequest(
      { runId, conversationKey, needsGpu, joinsTurnQueue: true },
      signal,
    ).then(() => {
      started.push(runId)
    })
    return { admitted, started }
  }

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  it('lets one member hold the place; the others start FIFO as each one finishes', async () => {
    setOrchestratorDeps(deps())
    const order: string[] = []
    const track = (runId: string, conversationKey: string) =>
      submitTextRequest({ runId, conversationKey, needsGpu: true, joinsTurnQueue: true }).then(() =>
        order.push(runId),
      )

    const a = track('turn-a', 'session-a')
    const b = track('turn-b', 'session-b')
    const c = track('turn-c', 'session-c')
    await a
    await settle()
    expect(order).toEqual(['turn-a'])

    finishTextRequest('turn-a')
    await b
    await settle()
    expect(order).toEqual(['turn-a', 'turn-b'])

    finishTextRequest('turn-b')
    await c
    expect(order).toEqual(['turn-a', 'turn-b', 'turn-c'])
    finishTextRequest('turn-c')
  })

  it('queues cloud agent turns like local ones', async () => {
    setOrchestratorDeps(deps())
    const local = member('turn-local', 'session-a', true)
    await local.admitted
    const cloud = member('turn-cloud', 'session-b', false)
    await settle()
    expect(cloud.started).toEqual([])

    finishTextRequest('turn-local')
    await cloud.admitted
    expect(cloud.started).toEqual(['turn-cloud'])
    finishTextRequest('turn-cloud')
  })

  it('does not hold up text requests outside the Turn Queue', async () => {
    setOrchestratorDeps(deps())
    await member('turn-agent', 'session-a').admitted
    await submitTextRequest({ runId: 'cloud-chat', conversationKey: 'c1', needsGpu: false })
    expect(textRequestsOpen()).toBe(2)
    finishTextRequest('cloud-chat')
    finishTextRequest('turn-agent')
  })

  it('dequeues a waiting member on abort without touching the holder', async () => {
    setOrchestratorDeps(deps())
    await member('turn-a', 'session-a').admitted
    const ac = new AbortController()
    const b = member('turn-b', 'session-b', true, ac.signal)
    const c = member('turn-c', 'session-c')
    await settle()

    ac.abort()
    await expect(b.admitted).rejects.toThrow('Cancelled while waiting in the Turn Queue.')
    expect(b.started).toEqual([])
    expect(textRequestsOpen()).toBe(2)
    expect(c.started).toEqual([])

    finishTextRequest('turn-a')
    await c.admitted
    expect(c.started).toEqual(['turn-c'])
    finishTextRequest('turn-c')
  })

  it("runs the holder's nested media within its turn while other members wait", async () => {
    const d = deps()
    setOrchestratorDeps(d)
    await member('turn-a', 'session-a').admitted
    const b = member('turn-b', 'session-b')

    const hold = holdNextRun()
    const nested = submitArtifactRun(payload({ runId: 'media-a', conversationKey: 'session-a' }), {
      queue: 'queue',
    })
    await vi.waitFor(() => expect(activeRunId).toBe('media-a'))
    expect(b.started).toEqual([])
    hold.resolve({ state: 'completed', items: [] })
    expect((await nested).state).toBe('completed')
    finishTextRequest('turn-a')
    await b.admitted
    finishTextRequest('turn-b')
  })

  it('two agent sessions that both generate media do not deadlock', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const a = member('turn-a', 'session-a')
    const b = member('turn-b', 'session-b')
    await a.admitted

    const holdA = holdNextRun()
    const mediaA = submitArtifactRun(payload({ runId: 'media-a', conversationKey: 'session-a' }), {
      queue: 'queue',
    })
    await vi.waitFor(() => expect(activeRunId).toBe('media-a'))
    holdA.resolve({ state: 'completed', items: [] })
    expect((await mediaA).state).toBe('completed')
    finishTextRequest('turn-a')

    await b.admitted
    const holdB = holdNextRun()
    const mediaB = submitArtifactRun(payload({ runId: 'media-b', conversationKey: 'session-b' }), {
      queue: 'queue',
    })
    await vi.waitFor(() => expect(activeRunId).toBe('media-b'))
    holdB.resolve({ state: 'completed', items: [] })
    expect((await mediaB).state).toBe('completed')
    finishTextRequest('turn-b')
    expect(textRequestsOpen()).toBe(0)
  })

  it('announces each waiting member’s position, and every move up as members ahead leave', async () => {
    setOrchestratorDeps(deps())
    await member('turn-a', 'session-a').admitted
    const b = member('turn-b', 'session-b')
    const ac = new AbortController()
    const c = member('turn-c', 'session-c', true, ac.signal)
    const d = member('turn-d', 'session-d')
    await settle()

    ac.abort()
    await expect(c.admitted).rejects.toThrow('Cancelled while waiting in the Turn Queue.')
    finishTextRequest('turn-a')
    await b.admitted
    finishTextRequest('turn-b')
    await d.admitted
    finishTextRequest('turn-d')

    const positions = queueEvents
      .filter((e) => e.kind === 'text' && e.action !== 'finished')
      .map((e) => [e.runKey, e.action, e.position, e.conversationKey])
    expect(positions).toEqual([
      ['turn-a', 'enqueued', undefined, 'session-a'],
      ['turn-a', 'started', undefined, 'session-a'],
      ['turn-b', 'enqueued', 1, 'session-b'],
      ['turn-c', 'enqueued', 2, 'session-c'],
      ['turn-d', 'enqueued', 3, 'session-d'],
      // c withdrawn: only d, behind it, moves up.
      ['turn-d', 'moved', 2, 'session-d'],
      // a done: b takes the place, d is next.
      ['turn-d', 'moved', 1, 'session-d'],
      ['turn-b', 'started', undefined, 'session-b'],
      ['turn-d', 'started', undefined, 'session-d'],
    ])
  })

  it('gives text requests outside the Turn Queue no position', async () => {
    setOrchestratorDeps(deps())
    await member('turn-agent', 'session-a').admitted
    await submitTextRequest({ runId: 'cloud-chat', conversationKey: 'c1', needsGpu: false })
    const chat = queueEvents.filter((e) => e.runKey === 'cloud-chat')
    expect(chat.map((e) => e.position)).toEqual([undefined, undefined])
    finishTextRequest('cloud-chat')
    finishTextRequest('turn-agent')
  })

  it('tells a waiting member what kind of work holds the place, as the holder changes', async () => {
    setOrchestratorDeps(deps())
    await submitTextRequest({
      runId: 'turn-agent',
      conversationKey: 'session-a',
      needsGpu: false,
      joinsTurnQueue: true,
      work: 'agent',
    })
    const summary = submitTextRequest({
      runId: 'summary',
      conversationKey: 'home-agent-summarize',
      needsGpu: true,
      joinsTurnQueue: true,
      work: 'summary',
    })
    const chat = submitTextRequest({
      runId: 'turn-chat',
      conversationKey: 'conv-1',
      needsGpu: true,
      joinsTurnQueue: true,
      work: 'chat',
    })
    await settle()

    finishTextRequest('turn-agent')
    await summary
    finishTextRequest('summary')
    await chat
    finishTextRequest('turn-chat')

    const waits = queueEvents
      .filter((e) => e.runKey === 'turn-chat')
      .map((e) => [e.action, e.position, e.work, e.holder])
    expect(waits).toEqual([
      ['enqueued', 2, 'chat', 'agent'],
      ['moved', 1, 'chat', 'summary'],
      ['started', undefined, 'chat', undefined],
      ['finished', undefined, 'chat', undefined],
    ])
  })
})

describe('panel runs in the Turn Queue', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    prepareRunModelsMock.mockResolvedValue({ state: 'ready' })
    queueEvents.length = 0
    phaseEvents.length = 0
    activeRunId = null
    resetOrchestratorForTest()
  })

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  function holdTurn(runId: string, conversationKey: string, work: 'agent' | 'chat' = 'agent') {
    return submitTextRequest({
      runId,
      conversationKey,
      needsGpu: true,
      joinsTurnQueue: true,
      work,
    })
  }

  it('waits for the turn holding the place instead of being refused', async () => {
    setOrchestratorDeps(deps())
    await holdTurn('turn-chat', 'c1', 'chat')

    const hold = holdNextRun()
    const panel = submitArtifactRun(payload({ runId: 'panel-1' }))
    await settle()
    expect(startArtifactRunMock).not.toHaveBeenCalled()
    expect(phaseEvents.map((e) => [e.tag.runId, e.phase])).toEqual([['panel-1', 'queued']])
    expect(queueEvents.find((e) => e.runKey === 'panel-1')).toMatchObject({
      kind: 'artifact',
      action: 'enqueued',
      position: 1,
      work: 'generation',
      holder: 'chat',
    })
    expect(artifactWorkOpen()).toBe(true)

    finishTextRequest('turn-chat')
    await vi.waitFor(() => expect(activeRunId).toBe('panel-1'))
    hold.resolve({ state: 'completed', items: [] })
    expect((await panel).state).toBe('completed')
    expect(artifactWorkOpen()).toBe(false)
  })

  it('holds the place while it runs: a turn submitted meanwhile starts after it, GPU returned', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const hold = holdNextRun()
    const panel = submitArtifactRun(payload({ runId: 'panel-1' }))
    await vi.waitFor(() => expect(activeRunId).toBe('panel-1'))

    let started = false
    const turn = holdTurn('turn-a', 'session-a').then(() => {
      started = true
    })
    await settle()
    expect(started).toBe(false)
    expect(queueEvents.find((e) => e.runKey === 'turn-a')).toMatchObject({
      action: 'enqueued',
      position: 1,
      holder: 'generation',
    })

    hold.resolve({ state: 'completed', items: [] })
    expect((await panel).state).toBe('completed')
    await turn
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
    finishTextRequest('turn-a')
  })

  it('cancelling a waiting panel run dequeues it without touching the holder', async () => {
    setOrchestratorDeps(deps())
    await holdTurn('turn-a', 'session-a')
    const panel = submitArtifactRun(payload({ runId: 'panel-1' }))
    const behind = holdTurn('turn-b', 'session-b')
    await settle()

    cancelArtifactRun('panel-1')
    expect((await panel).state).toBe('cancelled')
    expect(phaseEvents.map((e) => e.phase)).toEqual(['queued', 'cancelled'])
    expect(cancelActiveMock).not.toHaveBeenCalled()
    expect(artifactWorkOpen()).toBe(false)
    expect(
      queueEvents.filter((e) => e.runKey === 'turn-b').map((e) => [e.action, e.position]),
    ).toEqual([
      ['enqueued', 2],
      ['moved', 1],
    ])

    finishTextRequest('turn-a')
    await behind
    finishTextRequest('turn-b')
    expect(startArtifactRunMock).not.toHaveBeenCalled()
  })

  it('a replaced window drops panel runs still waiting for the place', async () => {
    setOrchestratorDeps(deps())
    await holdTurn('turn-a', 'session-a')
    const panel = submitArtifactRun(payload({ runId: 'panel-1' }))
    cancelAllArtifactRuns('The app window was replaced')
    expect((await panel).state).toBe('cancelled')
    finishTextRequest('turn-a')
    expect(artifactWorkOpen()).toBe(false)
  })

  it("runs the holding turn's nested media ahead of panel runs waiting for the place", async () => {
    setOrchestratorDeps(deps())
    await holdTurn('turn-a', 'session-a')
    const panel = submitArtifactRun(payload({ runId: 'panel-1' }))

    const holdNested = holdNextRun()
    const nested = submitArtifactRun(payload({ runId: 'media-a', conversationKey: 'session-a' }), {
      queue: 'queue',
    })
    await vi.waitFor(() => expect(activeRunId).toBe('media-a'))
    holdNested.resolve({ state: 'completed', items: [] })
    expect((await nested).state).toBe('completed')

    const holdPanel = holdNextRun()
    await settle()
    expect(startArtifactRunMock).toHaveBeenCalledTimes(1)

    finishTextRequest('turn-a')
    await vi.waitFor(() => expect(activeRunId).toBe('panel-1'))
    holdPanel.resolve({ state: 'completed', items: [] })
    expect((await panel).state).toBe('completed')
  })

  it('back-to-back panel runs share one GPU swap', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const holdOne = holdNextRun()
    const first = submitArtifactRun(payload({ runId: 'panel-1' }))
    await vi.waitFor(() => expect(d.stopChatForMedia).toHaveBeenCalledTimes(1))
    const holdTwo = holdNextRun()
    const second = submitArtifactRun(payload({ runId: 'panel-2' }))

    holdOne.resolve({ state: 'completed', items: [] })
    await first
    await vi.waitFor(() => expect(activeRunId).toBe('panel-2'))
    expect(d.freeComfyMemory).not.toHaveBeenCalled()
    expect(d.restartChatBackend).not.toHaveBeenCalled()

    holdTwo.resolve({ state: 'completed', items: [] })
    await second
    expect(d.stopChatForMedia).toHaveBeenCalledTimes(1)
    expect(d.freeComfyMemory).toHaveBeenCalledTimes(1)
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)
  })
})

describe('paused members', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    prepareRunModelsMock.mockResolvedValue({ state: 'ready' })
    queueEvents.length = 0
    phaseEvents.length = 0
    activeRunId = null
    resetOrchestratorForTest()
  })

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  /** A pausable member recording what it hears, in order. */
  function pausable(runId: string, conversationKey: string, log: string[], signal?: AbortSignal) {
    const pause: TurnPause = {
      onUserWait: (waiting, reason) =>
        log.push(
          `${runId} ${waiting ? 'paused' : 'answered'}${reason ? ` for ${reason.summary}` : ''}`,
        ),
      onRequeued: () => log.push(`${runId} requeued`),
      readyAgain: async () => {
        log.push(`${runId} ready again`)
      },
    }
    return submitTextRequest(
      { runId, conversationKey, needsGpu: true, joinsTurnQueue: true, work: 'agent', pause },
      signal,
    ).then(() => log.push(`${runId} started`))
  }

  function waiting(runId: string, conversationKey: string, log: string[]) {
    return submitTextRequest({
      runId,
      conversationKey,
      needsGpu: true,
      joinsTurnQueue: true,
      work: 'agent',
    }).then(() => log.push(`${runId} started`))
  }

  it('gives the place to the next member while the user is asked', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    await pausable('turn-a', 'session-a', log)
    const b = waiting('turn-b', 'session-b', log)
    await settle()
    expect(log).toEqual(['turn-a started'])

    const answered = beginUserWait('session-a')
    await b
    expect(log).toEqual(['turn-a started', 'turn-a paused', 'turn-b started'])

    answered()
    expect(log.at(-1)).toBe('turn-a answered')
    finishTextRequest('turn-b')
    finishTextRequest('turn-a')
  })

  it('takes the place back at the front of the queue, ahead of members that waited longer', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    await pausable('turn-a', 'session-a', log)
    const b = waiting('turn-b', 'session-b', log)
    const c = waiting('turn-c', 'session-c', log)
    await settle()

    beginUserWait('session-a')()
    await b
    let reclaimed = false
    const back = reclaimTurnPlace('turn-a').then(() => {
      reclaimed = true
    })
    await settle()
    expect(reclaimed).toBe(false)

    finishTextRequest('turn-b')
    await back
    expect(log.slice(-2)).toEqual(['turn-a requeued', 'turn-a ready again'])
    expect(log).not.toContain('turn-c started')

    finishTextRequest('turn-a')
    await c
    expect(log.at(-1)).toBe('turn-c started')
    finishTextRequest('turn-c')

    const moves = queueEvents
      .filter(
        (e) =>
          e.kind === 'text' &&
          ['yielded', 'reclaimed', 'enqueued', 'moved'].includes(String(e.action)),
      )
      .map((e) => [e.runKey, e.action, e.position])
    expect(moves).toEqual([
      ['turn-a', 'enqueued', undefined],
      ['turn-b', 'enqueued', 1],
      ['turn-c', 'enqueued', 2],
      ['turn-a', 'yielded', undefined],
      ['turn-c', 'moved', 1],
      ['turn-a', 'enqueued', 1],
      ['turn-c', 'moved', 2],
      // b done: a holds the place again, c is next.
      ['turn-c', 'moved', 1],
      ['turn-a', 'reclaimed', undefined],
    ])
  })

  it('takes a free place back at once, and re-runs readiness before resolving', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    await pausable('turn-a', 'session-a', log)
    beginUserWait('session-a')()
    await reclaimTurnPlace('turn-a')
    expect(log).toEqual([
      'turn-a started',
      'turn-a paused',
      'turn-a answered',
      'turn-a ready again',
    ])
    finishTextRequest('turn-a')
  })

  it('stays paused until every open question is answered', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    await pausable('turn-a', 'session-a', log)
    const first = beginUserWait('session-a')
    const second = beginUserWait('session-a')
    first()
    expect(log).toEqual(['turn-a started', 'turn-a paused', 'turn-a paused'])
    second()
    expect(log.at(-1)).toBe('turn-a answered')
    finishTextRequest('turn-a')
  })

  it('names the latest open question while paused, and the one left once it is answered', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    await pausable('turn-a', 'session-a', log)
    const voice = beginUserWait('session-a', { kind: 'download', summary: 'voice' })
    const card = beginUserWait('session-a', { kind: 'confirmation', summary: 'card' })
    expect(log.slice(1)).toEqual(['turn-a paused for voice', 'turn-a paused for card'])
    card()
    expect(log.at(-1)).toBe('turn-a paused for voice')
    const embedding = beginUserWait('session-a', { kind: 'download', summary: 'embedding' })
    voice()
    expect(log.at(-1)).toBe('turn-a paused for embedding')
    embedding()
    expect(log.at(-1)).toBe('turn-a answered')
    finishTextRequest('turn-a')
  })

  it('leaves a member that cannot pause holding its place', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    await waiting('turn-a', 'session-a', log)
    const b = waiting('turn-b', 'session-b', log)
    beginUserWait('session-a')()
    await settle()
    expect(log).toEqual(['turn-a started'])
    finishTextRequest('turn-a')
    await b
    finishTextRequest('turn-b')
  })

  it('a paused member cancelled while it waits to reclaim leaves the queue without starting', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    const ac = new AbortController()
    await pausable('turn-a', 'session-a', log, ac.signal)
    const b = waiting('turn-b', 'session-b', log)
    beginUserWait('session-a')()
    await b
    const back = reclaimTurnPlace('turn-a', ac.signal)
    ac.abort()
    await expect(back).rejects.toThrow('Cancelled while waiting in the Turn Queue.')
    finishTextRequest('turn-a')
    expect(log).not.toContain('turn-a ready again')
    finishTextRequest('turn-b')
    expect(textRequestsOpen()).toBe(0)
  })

  it("lets the next member's media take the GPU while the holder is paused", async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const log: string[] = []
    await pausable('turn-a', 'session-a', log)
    const b = waiting('turn-b', 'session-b', log)
    beginUserWait('session-a')
    await b

    const hold = holdNextRun()
    const media = submitArtifactRun(payload({ runId: 'media-b', conversationKey: 'session-b' }), {
      queue: 'queue',
    })
    await vi.waitFor(() => expect(activeRunId).toBe('media-b'))
    expect(d.stopChatForMedia).toHaveBeenCalledTimes(1)
    hold.resolve({ state: 'completed', items: [] })
    expect((await media).state).toBe('completed')
    finishTextRequest('turn-b')
    finishTextRequest('turn-a')
  })
})

describe('panel runs waiting on model download consent', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    prepareRunModelsMock.mockResolvedValue({ state: 'ready' })
    queueEvents.length = 0
    phaseEvents.length = 0
    activeRunId = null
    resetOrchestratorForTest()
  })

  const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

  function member(runId: string, log: string[]) {
    return submitTextRequest({
      runId,
      conversationKey: runId,
      needsGpu: true,
      joinsTurnQueue: true,
      work: 'agent',
    }).then(() => log.push(`${runId} started`))
  }

  /** Arms the next pre-flight to find models missing and wait for the user's answer. */
  function askNextRun(): { answer: (state: 'ready' | 'declined') => void } {
    const answer = deferred()
    prepareRunModelsMock.mockImplementationOnce(async (_payload, onAsk) => {
      onAsk()
      return { state: await answer.promise }
    })
    return { answer: (state) => answer.resolve(state) }
  }

  it('asks at once, even while it waits behind another turn', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    await member('turn-a', log)
    askNextRun()
    void submitArtifactRun(payload({ runId: 'panel-1' }))
    expect(prepareRunModelsMock).toHaveBeenCalledTimes(1)
    cancelArtifactRun('panel-1')
    finishTextRequest('turn-a')
  })

  it('gives its place to the next member while the user decides, then runs first once answered', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    const { answer } = askNextRun()
    const hold = holdNextRun()
    const panel = submitArtifactRun(payload({ runId: 'panel-1' }))
    await settle()
    const b = member('turn-b', log)
    await b
    expect(log).toEqual(['turn-b started'])
    expect(startArtifactRunMock).not.toHaveBeenCalled()

    const c = member('turn-c', log)
    answer('ready')
    await settle()
    expect(startArtifactRunMock).not.toHaveBeenCalled()

    finishTextRequest('turn-b')
    await vi.waitFor(() => expect(activeRunId).toBe('panel-1'))
    expect(startArtifactRunMock.mock.calls[0][0]).toMatchObject({ modelsConsented: true })
    expect(log).toEqual(['turn-b started'])

    hold.resolve({ state: 'completed', items: [] })
    expect((await panel).state).toBe('completed')
    await c
    expect(log).toEqual(['turn-b started', 'turn-c started'])
    finishTextRequest('turn-c')

    const moves = queueEvents
      .filter((e) => e.runKey === 'panel-1' || e.runKey === 'turn-c')
      .filter((e) => ['yielded', 'reclaimed', 'enqueued', 'moved'].includes(String(e.action)))
      .map((e) => [e.runKey, e.action, e.position])
    expect(moves).toEqual([
      ['panel-1', 'yielded', undefined],
      ['turn-c', 'enqueued', 1],
      ['panel-1', 'enqueued', 1],
      ['turn-c', 'moved', 2],
      ['turn-c', 'moved', 1],
      ['panel-1', 'reclaimed', undefined],
    ])
  })

  it('returns the GPU to chat when it gives up the place it took after another panel run', async () => {
    const d = deps()
    setOrchestratorDeps(d)
    const log: string[] = []
    const holdFirst = holdNextRun()
    const first = submitArtifactRun(payload({ runId: 'panel-1' }))
    await vi.waitFor(() => expect(activeRunId).toBe('panel-1'))
    const { answer } = askNextRun()
    const second = submitArtifactRun(payload({ runId: 'panel-2' }))
    const b = member('turn-b', log)

    holdFirst.resolve({ state: 'completed', items: [] })
    await first
    await b
    expect(d.restartChatBackend).toHaveBeenCalledTimes(1)

    answer('declined')
    expect((await second).state).toBe('cancelled')
    finishTextRequest('turn-b')
    expect(startArtifactRunMock).toHaveBeenCalledTimes(1)
  })

  it('leaves the queue without running when the download is declined while it waits', async () => {
    setOrchestratorDeps(deps())
    const log: string[] = []
    await member('turn-a', log)
    const { answer } = askNextRun()
    const panel = submitArtifactRun(payload({ runId: 'panel-1' }))
    const b = member('turn-b', log)
    await settle()

    answer('declined')
    expect((await panel).state).toBe('cancelled')
    expect(phaseEvents.map((e) => e.phase)).toEqual(['queued', 'cancelled'])
    expect(queueEvents.filter((e) => e.runKey === 'turn-b').map((e) => e.position)).toEqual([2, 1])

    finishTextRequest('turn-a')
    await b
    finishTextRequest('turn-b')
    expect(startArtifactRunMock).not.toHaveBeenCalled()
    expect(artifactWorkOpen()).toBe(false)
  })

  it('fails with the reason when its models cannot be checked', async () => {
    setOrchestratorDeps(deps())
    prepareRunModelsMock.mockResolvedValueOnce({
      state: 'failed',
      error: 'Required models are unavailable: gated',
    })
    const result = await submitArtifactRun(payload({ runId: 'panel-1' }))
    expect(result).toEqual({
      state: 'failed',
      items: [],
      error: 'Required models are unavailable: gated',
    })
    expect(phaseEvents.map((e) => e.phase)).toEqual(['failed'])
    expect(startArtifactRunMock).not.toHaveBeenCalled()
  })

  it('a stop while the user decides ends the run, and the answer is ignored', async () => {
    setOrchestratorDeps(deps())
    const { answer } = askNextRun()
    const panel = submitArtifactRun(payload({ runId: 'panel-1' }))
    await settle()
    cancelArtifactRun('panel-1')
    expect((await panel).state).toBe('cancelled')
    answer('ready')
    await settle()
    expect(startArtifactRunMock).not.toHaveBeenCalled()
    expect(artifactWorkOpen()).toBe(false)
  })
})
