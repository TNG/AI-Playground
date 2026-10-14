import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTask, AgentTaskOutcome, AgentTaskStep } from '@/types/agentTaskIpc'
import { useAgentMode } from './agentMode'
import { AGENT_PRESET } from './agentModeSessions'
import { userMessagePrompt } from './agentModeTurn'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { createAppError, extractMessage } from '@/assets/js/errors/appError'
import { cloneForIpc } from '@/lib/cloneForIpc'

export type TaskDraft = { name: string; steps: AgentTaskStep[] }

/** Why a draft cannot be saved yet. */
export type SaveTaskBlocker = 'name' | 'no-steps' | 'empty-step' | 'no-folder'

export type TaskTemplateSummary = {
  workspaceDir: string
  backend: AgentSessionSettings['backend']
  model: AgentSessionSettings['model']
  capabilityCount: number
}

/** A Task Run in flight; `stepIndex` is 1-based. Memory only. */
export type TaskRun = { stepIndex: number; stepCount: number; sessionId: string }

export type TaskState = { running: TaskRun } | { idle: AgentTaskOutcome | undefined }

export type SaveTaskResult =
  { ok: true; task: AgentTask } | { ok: false; reason: SaveTaskBlocker | 'persist-failed' }

export type RunTaskResult = { ok: true } | { ok: false; reason: 'no-task' | 'running' }

type RunEnd = Pick<AgentTaskOutcome, 'kind' | 'stepIndex' | 'message'>

export const useAgentTasks = defineStore('agentTasks', () => {
  const agentMode = useAgentMode()
  const errors = useErrors()
  const i18n = useI18N()

  const tasks = ref<AgentTask[]>([])

  const runs = ref<Record<string, TaskRun>>({})
  /** The Task as it was when its run started; edits to the list never reach a running run. */
  const runPlans: Record<string, AgentTask> = {}

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
    if (!(await persistTask(task))) return { ok: false, reason: 'persist-failed' }
    tasks.value = [...tasks.value, task]
    return { ok: true, task }
  }

  /** Upsert one Task into the tasks file; a failure is toasted. */
  async function persistTask(task: AgentTask): Promise<boolean> {
    const result = await window.electronAPI.agentMode
      .saveTask(cloneForIpc(task))
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
    if (result.success) return true
    errors.report(
      createAppError({
        category: 'backend',
        code: 'agent-tasks/save-failed',
        userMessage: i18n.state.AGENT_TASK_SAVE_FAILED ?? 'Could not save the task.',
        technicalMessage: result.error,
        surface: 'toast',
      }),
    )
    return false
  }

  /** The sessions the Task created stay. Refused while the Task runs. */
  async function deleteTask(id: string): Promise<boolean> {
    if (runs.value[id]) return false
    const result = await window.electronAPI.agentMode.deleteTask(id).catch((error: unknown) => ({
      success: false as const,
      error: String(error),
    }))
    if (!result.success) {
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-tasks/delete-failed',
          userMessage: i18n.state.AGENT_TASK_DELETE_FAILED ?? 'Could not delete the task.',
          technicalMessage: result.error,
          surface: 'toast',
        }),
      )
      return false
    }
    tasks.value = tasks.value.filter((task) => task.id !== id)
    return true
  }

  function taskState(id: string): TaskState {
    const run = runs.value[id]
    if (run) return { running: { ...run } }
    return { idle: tasks.value.find((task) => task.id === id)?.lastOutcome }
  }

  /**
   * Start a Task Run in the background: a new Task Session on the Task's folder and Settings
   * Template, its Steps sent one by one as each previous turn settles.
   */
  function runTask(id: string): RunTaskResult {
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return { ok: false, reason: 'no-task' }
    if (runs.value[id]) return { ok: false, reason: 'running' }
    const plan = cloneForIpc(task)
    const sessionId = agentMode.createSession({
      workspaceDir: plan.workspaceDir,
      settings: cloneForIpc(plan.settingsTemplate),
      presetName: AGENT_PRESET,
      title: plan.name,
      taskId: plan.id,
    })
    runPlans[id] = plan
    runs.value = { ...runs.value, [id]: { sessionId, stepIndex: 1, stepCount: plan.steps.length } }
    void sendStep(id, 1)
    return { ok: true }
  }

  async function sendStep(taskId: string, stepIndex: number): Promise<void> {
    const run = runs.value[taskId]
    const plan = runPlans[taskId]
    if (!run || !plan) return
    runs.value = { ...runs.value, [taskId]: { ...run, stepIndex } }
    const result = await agentMode.sendToSession(run.sessionId, plan.steps[stepIndex - 1].prompt, {
      settings: cloneForIpc(plan.settingsTemplate),
    })
    if (!result.ok) await settleRun(taskId, { kind: 'failed', stepIndex, message: result.message })
  }

  function runOfSession(sessionId: string): string | undefined {
    return Object.keys(runs.value).find((id) => runs.value[id].sessionId === sessionId)
  }

  agentMode.onTurnSettled((sessionId, outcome) => {
    const taskId = runOfSession(sessionId)
    if (!taskId) return
    const { stepIndex, stepCount } = runs.value[taskId]
    if (outcome.kind === 'completed') {
      if (stepIndex < stepCount) void sendStep(taskId, stepIndex + 1)
      else void settleRun(taskId, { kind: 'completed' })
    } else if (outcome.kind === 'error') {
      void settleRun(taskId, { kind: 'failed', stepIndex, message: outcome.message })
    } else {
      void settleRun(taskId, { kind: 'stopped', stepIndex })
    }
  })

  /** End the run and keep how it ended as the Task's only outcome. */
  async function settleRun(taskId: string, end: RunEnd): Promise<void> {
    const run = runs.value[taskId]
    if (!run) return
    const { [taskId]: _ended, ...rest } = runs.value
    runs.value = rest
    delete runPlans[taskId]
    const task = tasks.value.find((entry) => entry.id === taskId)
    if (!task) return
    const lastOutcome: AgentTaskOutcome = {
      kind: end.kind,
      at: Date.now(),
      sessionId: run.sessionId,
      stepCount: run.stepCount,
      ...(end.stepIndex !== undefined ? { stepIndex: end.stepIndex } : {}),
      ...(end.message !== undefined ? { message: end.message } : {}),
    }
    const updated: AgentTask = { ...task, lastOutcome }
    tasks.value = tasks.value.map((entry) => (entry.id === taskId ? updated : entry))
    await persistTask(updated)
  }

  // The Task being built in the Agent Settings panel; memory only.
  const draft = ref<TaskDraft>(emptyDraft())

  const draftBlocker = computed(() => saveBlocker(draft.value))

  /** The folder and Settings Template a save would capture right now. */
  const draftTemplate = computed<TaskTemplateSummary>(() => {
    const settings = agentMode.openSessionSettings
    return {
      workspaceDir: agentMode.workspaceDir,
      backend: settings.backend,
      model: settings.model,
      capabilityCount: settings.capabilities?.length ?? 0,
    }
  })

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

  function addStep(): void {
    draft.value.steps = [...draft.value.steps, { id: crypto.randomUUID(), prompt: '' }]
  }

  function removeStep(id: string): void {
    draft.value.steps = draft.value.steps.filter((step) => step.id !== id)
  }

  function moveStep(id: string, direction: 'up' | 'down'): void {
    const steps = [...draft.value.steps]
    const from = steps.findIndex((step) => step.id === id)
    const to = direction === 'up' ? from - 1 : from + 1
    if (from < 0 || to < 0 || to >= steps.length) return
    ;[steps[from], steps[to]] = [steps[to], steps[from]]
    draft.value.steps = steps
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
    deleteTask,
    taskState,
    runTask,
    draft,
    draftBlocker,
    draftTemplate,
    createStepsFromSession,
    addStep,
    removeStep,
    moveStep,
    saveDraft,
  }
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useAgentTasks, import.meta.hot))
