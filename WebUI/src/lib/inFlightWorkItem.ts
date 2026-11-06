import type { AgentTask, AgentTaskActiveRun } from '@/types/agentTaskIpc'
import type { InFlightWorkItem } from '@/types/lifecycleIpc'

type TaskRunItem = Extract<InFlightWorkItem, { kind: 'task-run' }>

/** A Task Run as the close question names it; with no run yet it is in its pre-flight checks. */
export function taskRunWorkItem(
  task: Pick<AgentTask, 'id' | 'name'>,
  run?: Pick<AgentTaskActiveRun, 'sessionId' | 'stepIndex' | 'stepCount'>,
): TaskRunItem {
  if (!run) {
    return { kind: 'task-run', taskId: task.id, name: task.name, state: { status: 'starting' } }
  }
  return {
    kind: 'task-run',
    taskId: task.id,
    sessionId: run.sessionId,
    name: task.name,
    state: { status: 'step', index: run.stepIndex, count: run.stepCount },
  }
}
