import type { NotificationTemplates } from '@/types/notificationsIpc'
import { fillTemplate } from './fillTemplate'

export type LabelTask = {
  name: string
  activeRun?: { sessionId: string; stepIndex: number; stepCount: number }
}

type LabelTemplates = Pick<NotificationTemplates, 'sessionLabel' | 'taskLabel' | 'untitled'>

/** A Task run reads "Task" (step 2/3); any other session its quoted title. */
export function notificationSessionLabel(
  templates: LabelTemplates,
  sessionId: string,
  title: string,
  tasks: readonly LabelTask[],
): string {
  const task = tasks.find((entry) => entry.activeRun?.sessionId === sessionId)
  if (task?.activeRun) {
    const { stepIndex, stepCount } = task.activeRun
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
