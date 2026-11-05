import type { OpenTextRequest } from './orchestrator'
import type { AgentTask } from '@/types/agentTaskIpc'
import type { ArtifactRunMode } from '@/types/artifactIpc'
import type { InFlightWorkItem, OpenArtifactRun, OpenChatTurn } from '@/types/lifecycleIpc'
import { taskRunWorkItem } from '@/lib/inFlightWorkItem'

export type InFlightWorkSources = {
  agentTurns: { sessionId: string; name?: string }[]
  chatTurns: OpenChatTurn[]
  textRequests: OpenTextRequest[]
  artifactRuns: OpenArtifactRun[]
  /** An enabled Schedule is not In-flight Work; only a Task Run's marker is. */
  tasks: Pick<AgentTask, 'id' | 'name' | 'activeRuns'>[]
  /** What only the window knows: Prompt Runs, and Task Runs whose marker is not on disk yet. */
  rendererWork: InFlightWorkItem[]
}

/** The window's Task Runs win over their markers: a marker lags the run by a write. */
function stepRuns(sources: InFlightWorkSources): InFlightWorkItem[] {
  const reported = sources.rendererWork.filter(
    (item) => item.kind === 'task-run' || item.kind === 'prompt-run',
  )
  const reportedRuns = new Set(
    reported.flatMap((item) =>
      item.kind === 'task-run' && item.sessionId ? [item.sessionId] : [],
    ),
  )
  const markers = sources.tasks.flatMap((task) =>
    (task.activeRuns ?? [])
      .filter((run) => !reportedRuns.has(run.sessionId))
      .map((run) => taskRunWorkItem(task, run)),
  )
  return [...markers, ...reported]
}

/** In-flight Work, one item per turn or run; queued media runs are counted per mode. */
export function collectInFlightWork(sources: InFlightWorkSources): InFlightWorkItem[] {
  const stateOf = (conversationKey: string, fallback: 'queued' | 'running') =>
    sources.textRequests.find(
      (request) => request.conversationKey === conversationKey && request.work !== 'summary',
    )?.state ?? fallback
  const items = stepRuns(sources)
  // A Step of a Task Run or Prompt Run is an agent turn; the run already names it.
  const runSessions = new Set(
    items.flatMap((item) => ('sessionId' in item && item.sessionId ? [item.sessionId] : [])),
  )
  for (const turn of sources.agentTurns) {
    if (runSessions.has(turn.sessionId)) continue
    items.push({
      kind: 'agent-turn',
      ...(turn.name ? { name: turn.name } : {}),
      state: { status: stateOf(turn.sessionId, 'queued') },
    })
  }
  for (const turn of sources.chatTurns) {
    const state = { status: stateOf(turn.conversationKey, 'running') }
    items.push(
      turn.homeAgent
        ? { kind: 'home-agent-turn', state }
        : { kind: 'chat-turn', ...(turn.title ? { name: turn.title } : {}), state },
    )
  }
  const queued = new Map<ArtifactRunMode, number>()
  for (const run of sources.artifactRuns) {
    if (run.executing)
      items.push({ kind: 'media-run', mode: run.mode, state: { status: 'running' } })
    else queued.set(run.mode, (queued.get(run.mode) ?? 0) + 1)
  }
  for (const [mode, count] of queued) {
    items.push({ kind: 'media-run', mode, state: { status: 'queued', count } })
  }
  return items
}

export type InFlightWorkDeps = {
  openAgentTurnSessionIds: () => string[]
  readAgentSessionTitle: (sessionId: string) => Promise<string>
  openChatTurns: () => OpenChatTurn[]
  openTextRequests: () => OpenTextRequest[]
  openArtifactRuns: () => OpenArtifactRun[]
  readAgentTasks: () => Promise<InFlightWorkSources['tasks']>
}

/** Main's live In-flight Work: what it owns, merged with the window's latest report. */
export function createInFlightWork(deps: InFlightWorkDeps) {
  let rendererWork: InFlightWorkItem[] = []
  return {
    /** Replaces the window's last report. */
    setRendererWork(work: InFlightWorkItem[]): void {
      rendererWork = work
    },
    async list(): Promise<InFlightWorkItem[]> {
      const sessionIds = deps.openAgentTurnSessionIds()
      const names = await Promise.all(
        sessionIds.map((id) => deps.readAgentSessionTitle(id).catch(() => '')),
      )
      return collectInFlightWork({
        agentTurns: sessionIds.map((sessionId, index) => ({ sessionId, name: names[index] })),
        chatTurns: deps.openChatTurns(),
        textRequests: deps.openTextRequests(),
        artifactRuns: deps.openArtifactRuns(),
        tasks: await deps.readAgentTasks().catch(() => []),
        rendererWork,
      })
    },
  }
}
