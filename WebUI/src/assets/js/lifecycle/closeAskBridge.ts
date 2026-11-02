import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useDialogStore } from '@/assets/js/store/dialogs'

let started = false

/** Shows main's close question in the close dialog and keeps it current. Call once from the entry. */
export function startCloseAskBridge(): void {
  if (started) return
  started = true
  const agentTasks = useAgentTasks()
  const dialogs = useDialogStore()
  window.electronAPI.lifecycle.onAskClose((question) => {
    dialogs.closeQuestion = question
  })
  window.electronAPI.lifecycle.onCloseQuestionChanged((question) => {
    if (dialogs.closeQuestion?.requestId === question.requestId) dialogs.closeQuestion = question
  })
  window.electronAPI.lifecycle.onHoldSchedules((held) => agentTasks.setSchedulesHeld(held))
  window.electronAPI.lifecycle.bridgeReady()
}
