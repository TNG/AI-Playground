import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { AgentTask, AgentTaskStep } from '@/types/agentTaskIpc'
import { useAgentMode } from './agentMode'
import { userMessagePrompt } from './agentModeTurn'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { createAppError, extractMessage } from '@/assets/js/errors/appError'
import { cloneForIpc } from '@/lib/cloneForIpc'

export type TaskDraft = { name: string; steps: AgentTaskStep[] }

/** Why a draft cannot be saved yet. */
export type SaveTaskBlocker = 'name' | 'no-steps' | 'empty-step' | 'no-folder'

export type SaveTaskResult =
  { ok: true; task: AgentTask } | { ok: false; reason: SaveTaskBlocker | 'persist-failed' }

export const useAgentTasks = defineStore('agentTasks', () => {
  const agentMode = useAgentMode()
  const errors = useErrors()
  const i18n = useI18N()

  const tasks = ref<AgentTask[]>([])

  async function init(): Promise<void> {
    try {
      const result = await window.electronAPI.agentMode.readTasks()
      if (!result.success) throw new Error(result.error)
      tasks.value = result.tasks
    } catch (error) {
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-tasks/read-failed',
          severity: 'warning',
          surface: 'toast',
          userMessage: i18n.state.AGENT_TASK_READ_FAILED ?? 'Could not read the saved tasks.',
          technicalMessage: extractMessage(error),
          cause: error,
        }),
      )
    }
  }

  /** The Open Session's user messages as Step prompts, "not run" ones included. */
  function stepsFromSession(): string[] {
    return agentMode.messages
      .filter((message) => message.role === 'user')
      .map((message) => userMessagePrompt(message))
  }

  function saveBlocker(draft: TaskDraft): SaveTaskBlocker | null {
    if (!draft.name.trim()) return 'name'
    if (draft.steps.length === 0) return 'no-steps'
    if (draft.steps.some((step) => !step.prompt.trim())) return 'empty-step'
    if (!agentMode.workspaceDir) return 'no-folder'
    return null
  }

  /** Store the draft with the Open Session's folder and the panel's Session Settings. */
  async function saveTask(draft: TaskDraft): Promise<SaveTaskResult> {
    const blocker = saveBlocker(draft)
    if (blocker) return { ok: false, reason: blocker }
    const now = Date.now()
    const task: AgentTask = {
      id: crypto.randomUUID(),
      name: draft.name.trim(),
      workspaceDir: agentMode.workspaceDir,
      settingsTemplate: cloneForIpc(agentMode.openSessionSettings),
      steps: draft.steps.map((step) => ({ id: step.id, prompt: step.prompt })),
      createdAt: now,
      updatedAt: now,
    }
    const result = await window.electronAPI.agentMode.saveTask(task).catch((error: unknown) => ({
      success: false as const,
      error: String(error),
    }))
    if (!result.success) {
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-tasks/save-failed',
          userMessage: i18n.state.AGENT_TASK_SAVE_FAILED ?? 'Could not save the task.',
          technicalMessage: result.error,
          surface: 'toast',
        }),
      )
      return { ok: false, reason: 'persist-failed' }
    }
    tasks.value = [...tasks.value, task]
    return { ok: true, task }
  }

  // The Task being built in the Agent Settings panel; memory only.
  const draft = ref<TaskDraft>(emptyDraft())

  const draftBlocker = computed(() => saveBlocker(draft.value))

  // Steps, folder and settings must all come from one session.
  watch(
    () => agentMode.openSessionId,
    () => {
      draft.value = emptyDraft()
    },
  )

  function emptyDraft(): TaskDraft {
    return { name: '', steps: [] }
  }

  /** Replace the draft's Steps with the Open Session's; the name defaults to its title. */
  function createStepsFromSession(): void {
    const title = agentMode.sessions[agentMode.openSessionId]?.title ?? ''
    draft.value = {
      name: title || draft.value.name,
      steps: stepsFromSession().map((prompt) => ({ id: crypto.randomUUID(), prompt })),
    }
  }

  async function saveDraft(): Promise<SaveTaskResult> {
    const result = await saveTask(draft.value)
    if (result.ok) draft.value = emptyDraft()
    return result
  }

  return {
    tasks,
    init,
    stepsFromSession,
    saveBlocker,
    saveTask,
    draft,
    draftBlocker,
    createStepsFromSession,
    saveDraft,
  }
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useAgentTasks, import.meta.hot))
