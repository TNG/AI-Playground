import type { NotificationTemplates } from '@/types/notificationsIpc'
import { fillTemplate } from './fillTemplate'

export type LabelTask = {
  name: string
  activeRuns?: { sessionId: string; stepIndex: number; stepCount: number }[]
}

type LabelTemplates = Pick<NotificationTemplates, 'sessionLabel' | 'taskLabel' | 'untitled'>

/** A Task run reads "Task" (step 2/3); any other session its quoted title. */
export function notificationSessionLabel(
  templates: LabelTemplates,
  sessionId: string,
  title: string,
  tasks: readonly LabelTask[],
): string {
  const task = tasks.find((entry) => runOf(entry, sessionId))
  const run = task && runOf(task, sessionId)
  if (task && run) {
    const { stepIndex, stepCount } = run
    if (!Number.isInteger(stepIndex) || stepIndex < 1 || stepIndex > stepCount) {
      return fillTemplate(templates.sessionLabel, { title: task.name })
    }
    return fillTemplate(templates.taskLabel, {
      task: task.name,
      step: String(stepIndex),
      steps: String(stepCount),
    })
  }
  return fillTemplate(templates.sessionLabel, { title: title || templates.untitled })
}

/** `agent` is the Agent's name the run started with, else its Harness Session's title. */
export function trialRunLabel(
  templates: Pick<NotificationTemplates, 'trialRunLabel' | 'untitled'>,
  agent: string | undefined,
): string {
  return fillTemplate(templates.trialRunLabel, { agent: agent || templates.untitled })
}

function runOf(task: LabelTask, sessionId: string) {
  return task.activeRuns?.find((run) => run.sessionId === sessionId)
}
