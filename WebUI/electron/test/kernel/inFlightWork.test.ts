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
    channelQueues: [],
    ...overrides,
  }
}

const dailyReport = {
  id: 'task-1',
  name: 'Daily report',
  schedules: [{ sessionRef: 'session-1', enabled: true }],
}
const run = (sessionId: string) => ({ sessionId, sessionRef: `ref-${sessionId}` })
const marker = () => ({ ...dailyReport, activeRuns: [run('s-1')] })
const runningTaskRun = (sessionId: string): InFlightWorkItem => ({
  kind: 'task-run',
  taskId: 'task-1',
  sessionId,
  name: 'Daily report',
  state: { status: 'running' },
})

describe('collectInFlightWork', () => {
  it("lists the Channels' queued messages", () => {
    const queued: InFlightWorkItem = {
      kind: 'channel-queue',
      channel: 'telegram',
      state: { status: 'queued', count: 3 },
    }
    expect(collectInFlightWork(sources({ channelQueues: [queued] }))).toEqual([queued])
  })

  it('lists nothing for an enabled Schedule alone', () => {
    expect(collectInFlightWork(sources({ tasks: [dailyReport] }))).toEqual([])
  })

  it('names an Agent Run from its marker as running', () => {
    expect(collectInFlightWork(sources({ tasks: [marker()] }))).toEqual([runningTaskRun('s-1')])
  })

  it('names a run from a marker written when runs counted Steps the same way', () => {
    const old = { ...dailyReport, activeRuns: [{ ...run('s-1'), stepIndex: 2, stepCount: 4 }] }

    expect(collectInFlightWork(sources({ tasks: [old] }))).toEqual([runningTaskRun('s-1')])
  })

  it("names each of an Agent's runs in different Sessions, deferring only the reported one", () => {
    const twoRuns = { ...dailyReport, activeRuns: [run('s-1'), run('s-2')] }

    expect(
      collectInFlightWork(sources({ tasks: [twoRuns], rendererWork: [runningTaskRun('s-1')] })),
    ).toEqual([runningTaskRun('s-2'), runningTaskRun('s-1')])
  })

  it('names a Task Run the window reports before its marker reaches disk', () => {
    expect(
      collectInFlightWork(sources({ tasks: [dailyReport], rendererWork: [runningTaskRun('s-1')] })),
    ).toEqual([runningTaskRun('s-1')])
  })

  it('names a run the window reports once, not again from its marker', () => {
    expect(
      collectInFlightWork(sources({ tasks: [marker()], rendererWork: [runningTaskRun('s-1')] })),
    ).toEqual([runningTaskRun('s-1')])
  })

  it('names a running Follow-up the window reports as its Agent Run, not as an agent turn', () => {
    expect(
      collectInFlightWork(
        sources({
          tasks: [dailyReport],
          agentTurns: [{ sessionId: 's-1', name: 'Daily report' }],
          rendererWork: [runningTaskRun('s-1')],
        }),
      ),
    ).toEqual([runningTaskRun('s-1')])
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

  it("leaves out the agent turn that is an Agent Run's turn", () => {
    const items = collectInFlightWork(
      sources({
        tasks: [marker()],
        agentTurns: [{ sessionId: 's-1', name: 'Report session' }],
        textRequests: [{ conversationKey: 's-1', state: 'running' }],
      }),
    )

    expect(items.map((item) => item.kind)).toEqual(['task-run'])
  })

  it('names a Trial Run in place of the agent turn that runs it', () => {
    const trialRun: InFlightWorkItem = {
      kind: 'trial-run',
      agentId: 'agent-1',
      sessionId: 'trial-harness',
      name: 'Morning news',
      state: { status: 'running' },
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
        tasks: [marker()],
        agentTurns: [{ sessionId: 's-9', name: 'Other' }],
        textRequests: [{ conversationKey: 's-9', state: 'paused' }],
      }),
    )

    expect(items[1]).toEqual({ kind: 'agent-turn', name: 'Other', state: { status: 'paused' } })
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
    channelQueues: () => [],
    ...overrides,
  })

  it("replaces the window's previous report with its latest one", async () => {
    const work = createInFlightWork(deps())
    work.setRendererWork([runningTaskRun('s-1')])
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
