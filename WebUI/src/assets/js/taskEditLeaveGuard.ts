import { computed, ref } from 'vue'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useUIStore } from '@/assets/js/store/ui'

// One question at a time for the whole window, answered by TaskEditDiscardDialog.
const pendingAnswer = ref<((discard: boolean) => void) | null>(null)

export function useTaskEditLeaveGuard() {
  const agentTasks = useAgentTasks()
  const uiStore = useUIStore()

  /** End the task edit, if any; unsaved edits only once the user agrees to discard them. */
  async function leaveTaskEdit(): Promise<boolean> {
    if (!agentTasks.editingTaskId) return true
    if (agentTasks.editDirty) {
      const discard = await new Promise<boolean>((resolve) => {
        pendingAnswer.value?.(false)
        pendingAnswer.value = resolve
      })
      if (!discard) return false
    }
    agentTasks.discardEdit()
    return true
  }

  /** Put the right sidebar into task mode for the Task, past the unsaved-draft guard. */
  async function editTask(id: string): Promise<void> {
    if (agentTasks.editingTaskId !== id) {
      if (!(await leaveTaskEdit())) return
      if (!agentTasks.beginEdit(id)) return
    }
    uiStore.openSettings()
  }

  function answer(discard: boolean): void {
    const resolve = pendingAnswer.value
    pendingAnswer.value = null
    resolve?.(discard)
  }

  const asking = computed(() => pendingAnswer.value !== null)

  return { leaveTaskEdit, editTask, asking, answer }
}
