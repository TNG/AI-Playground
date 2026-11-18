import type { NotificationTemplates } from '@/types/notificationsIpc'
import { fillTemplate } from './fillTemplate'

export type LabelTask = {
  name: string
  activeRuns?: { sessionId: string }[]
}

type LabelTemplates = Pick<NotificationTemplates, 'sessionLabel' | 'untitled'>

/** An Agent Run reads as its Agent's quoted name; any other session its quoted title. */
export function notificationSessionLabel(
  templates: LabelTemplates,
  sessionId: string,
  title: string,
  tasks: readonly LabelTask[],
): string {
  const task = tasks.find((entry) => entry.activeRuns?.some((run) => run.sessionId === sessionId))
  return fillTemplate(templates.sessionLabel, { title: task?.name || title || templates.untitled })
}

/** `agent` is the Agent's name the run started with, else its Harness Session's title. */
export function trialRunLabel(
  templates: Pick<NotificationTemplates, 'trialRunLabel' | 'untitled'>,
  agent: string | undefined,
): string {
  return fillTemplate(templates.trialRunLabel, { agent: agent || templates.untitled })
}
