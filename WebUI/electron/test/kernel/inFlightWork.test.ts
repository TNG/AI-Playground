import { describe, expect, it } from 'vitest'
import {
  collectInFlightWork,
  createInFlightWork,
  type InFlightWorkDeps,
  type InFlightWorkSources,
} from '../../kernel/inFlightWork'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'

// What main merges into the close question: its own turns and the tasks file, plus the window's report.

function sources(overrides: Partial<InFlightWorkSources>): InFlightWorkSources {
  return {
    agentTurns: [],
    chatTurns: [],
    textRequests: [],
    artifactRuns: [],
    tasks: [],
    rendererWork: [],
    ...overrides,
  }
}

const dailyReport = {
  id: 'task-1',
  name: 'Daily report',
  schedules: [{ sessionRef: 'session-1', enabled: true }],
}
const run = (sessionId: string, stepIndex: number) => ({
  sessionId,
  sessionRef: `ref-${sessionId}`,
  stepIndex,
  stepCount: 4,
})
const marker = (stepIndex: number) => ({ ...dailyReport, activeRuns: [run('s-1', stepIndex)] })
const reportedTaskRun = (index: number): InFlightWorkItem => ({
  kind: 'task-run',
  taskId: 'task-1',
  sessionId: 's-1',
  name: 'Daily report',
  state: { status: 'step', index, count: 4 },
})

describe('collectInFlightWork', () => {
  it('lists nothing for an enabled Schedule alone', () => {
    expect(collectInFlightWork(sources({ tasks: [dailyReport] }))).toEqual([])
  })

  it('names a Task Run from its marker, with its step', () => {
    expect(collectInFlightWork(sources({ tasks: [marker(2)] }))).toEqual([
      {
        kind: 'task-run',
        taskId: 'task-1',
        sessionId: 's-1',
        name: 'Daily report',
        state: { status: 'step', index: 2, count: 4 },
      },
    ])
  })

  it("names each of an Agent's runs in different Sessions, deferring only the reported one", () => {
    const twoRuns = { ...dailyReport, activeRuns: [run('s-1', 2), run('s-2', 1)] }

    expect(
      collectInFlightWork(sources({ tasks: [twoRuns], rendererWork: [reportedTaskRun(3)] })),
    ).toEqual([
      {
        kind: 'task-run',
        taskId: 'task-1',
        sessionId: 's-2',
        name: 'Daily report',
        state: { status: 'step', index: 1, count: 4 },
      },
      reportedTaskRun(3),
    ])
  })

  it('names a Task Run the window reports before its marker reaches disk', () => {
    expect(
      collectInFlightWork(sources({ tasks: [dailyReport], rendererWork: [reportedTaskRun(1)] })),
    ).toEqual([reportedTaskRun(1)])
  })

  it("takes the window's step over a marker that lags it", () => {
    expect(
      collectInFlightWork(sources({ tasks: [marker(2)], rendererWork: [reportedTaskRun(3)] })),
    ).toEqual([reportedTaskRun(3)])
  })

  it('names a Task Run still in its pre-flight checks, before it has a session', () => {
    const starting: InFlightWorkItem = {
      kind: 'task-run',
      taskId: 'task-1',
      name: 'Daily report',
      state: { status: 'starting' },
    }

    expect(
      collectInFlightWork(sources({ tasks: [dailyReport], rendererWork: [starting] })),
    ).toEqual([starting])
  })

  it("leaves out the agent turn that is a Task Run's Step", () => {
    const items = collectInFlightWork(
      sources({
        tasks: [marker(2)],
        agentTurns: [{ sessionId: 's-1', name: 'Report session' }],
        textRequests: [{ conversationKey: 's-1', state: 'running' }],
      }),
    )

    expect(items.map((item) => item.kind)).toEqual(['task-run'])
  })

  it("leaves out the agent turn that is a Prompt Run's Step", () => {
    const items = collectInFlightWork(
      sources({
        agentTurns: [{ sessionId: 's-2', name: 'Asteroids' }],
        textRequests: [{ conversationKey: 's-2', state: 'running' }],
        rendererWork: [
          {
            kind: 'prompt-run',
            sessionId: 's-2',
            name: 'Asteroids',
            state: { status: 'step', index: 1, count: 3 },
          },
        ],
      }),
    )

    expect(items.map((item) => item.kind)).toEqual(['prompt-run'])
  })

  it('names a Prompt Run between two Steps, when no agent turn is open', () => {
    const between: InFlightWorkItem = {
      kind: 'prompt-run',
      sessionId: 's-2',
      name: 'Asteroids',
      state: { status: 'step', index: 2, count: 3 },
    }

    expect(collectInFlightWork(sources({ rendererWork: [between] }))).toEqual([between])
  })

  it('names a Trial Run in place of the agent turn that is its Step', () => {
    const trialRun: InFlightWorkItem = {
      kind: 'trial-run',
      agentId: 'agent-1',
      sessionId: 'trial-harness',
      name: 'Morning news',
      state: { status: 'step', index: 1, count: 2 },
    }

    const items = collectInFlightWork(
      sources({
        agentTurns: [{ sessionId: 'trial-harness', name: 'Morning news' }],
        rendererWork: [trialRun],
      }),
    )

    expect(items).toEqual([trialRun])
  })

  it('keeps an agent turn in another session', () => {
    const items = collectInFlightWork(
      sources({
        tasks: [marker(2)],
        agentTurns: [{ sessionId: 's-9', name: 'Other' }],
        textRequests: [{ conversationKey: 's-9', state: 'paused' }],
      }),
    )

    expect(items[1]).toEqual({ kind: 'agent-turn', name: 'Other', state: { status: 'paused' } })
  })

  it('names a Home Agent reply without its thread title', () => {
    expect(
      collectInFlightWork(
        sources({ chatTurns: [{ conversationKey: 'c-1', homeAgent: true, title: 'Telegram' }] }),
      ),
    ).toEqual([{ kind: 'home-agent-turn', state: { status: 'running' } }])
  })

  it('counts queued media runs per mode and lists executing ones each', () => {
    const items = collectInFlightWork(
      sources({
        artifactRuns: [
          { mode: 'imageGen', executing: true },
          { mode: 'imageGen', executing: false },
          { mode: 'imageGen', executing: false },
          { mode: 'video', executing: false },
        ],
      }),
    )

    expect(items).toEqual([
      { kind: 'media-run', mode: 'imageGen', state: { status: 'running' } },
      { kind: 'media-run', mode: 'imageGen', state: { status: 'queued', count: 2 } },
      { kind: 'media-run', mode: 'video', state: { status: 'queued', count: 1 } },
    ])
  })
})

describe('createInFlightWork', () => {
  const deps = (overrides: Partial<InFlightWorkDeps> = {}): InFlightWorkDeps => ({
    openAgentTurnSessionIds: () => [],
    readAgentSessionTitle: async () => '',
    openChatTurns: () => [],
    openTextRequests: () => [],
    openArtifactRuns: () => [],
    readAgentTasks: async () => [],
    ...overrides,
  })

  it("replaces the window's previous report with its latest one", async () => {
    const work = createInFlightWork(deps())
    work.setRendererWork([reportedTaskRun(1)])
    work.setRendererWork([])

    await expect(work.list()).resolves.toEqual([])
  })

  it('still lists the work when a session title or the tasks file cannot be read', async () => {
    const work = createInFlightWork(
      deps({
        openAgentTurnSessionIds: () => ['s-1'],
        readAgentSessionTitle: async () => {
          throw new Error('gone')
        },
        readAgentTasks: async () => {
          throw new Error('unreadable')
        },
      }),
    )

    await expect(work.list()).resolves.toEqual([
      { kind: 'agent-turn', state: { status: 'queued' } },
    ])
  })
})
