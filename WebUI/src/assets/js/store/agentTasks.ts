import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type {
  AgentTask,
  AgentTaskActiveRun,
  AgentTaskOutcome,
  AgentTaskSchedule,
  AgentTaskStep,
} from '@/types/agentTaskIpc'
import { useAgentMode } from './agentMode'
import { AGENT_PRESET } from './agentModeSessions'
import { userMessagePrompt } from './agentModeTurn'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { createAppError, extractMessage } from '@/assets/js/errors/appError'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { withStepAdded, withStepMoved, withStepRemoved } from '@/lib/taskSteps'
import { nextSlotAfter, scheduleProblem, type ScheduleProblem } from '@/lib/taskSchedule'
import {
  describeSettingsProblems,
  type SessionSettingsProblem,
} from '@/lib/sessionSettingsProblems'

export type TaskDraft = { name: string; steps: AgentTaskStep[] }

/** A saved Task's editable fields, as task mode holds them until Save. */
export type TaskEditDraft = Pick<AgentTask, 'name' | 'workspaceDir' | 'steps' | 'settingsTemplate'>

/** Why a draft cannot be saved yet. */
export type SaveTaskBlocker = 'name' | 'no-steps' | 'empty-step' | 'no-folder'

export const SAVE_TASK_BLOCKER_KEYS = {
  name: 'AGENT_TASK_BLOCKED_NAME',
  'no-steps': 'AGENT_TASK_BLOCKED_NO_STEPS',
  'empty-step': 'AGENT_TASK_BLOCKED_EMPTY_STEP',
  'no-folder': 'AGENT_TASK_BLOCKED_NO_FOLDER',
} as const satisfies Record<SaveTaskBlocker, string>

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
  | { ok: true; task: AgentTask }
  | { ok: false; reason: SaveTaskBlocker | 'persist-failed' | 'no-task' }

export type RunTaskResult =
  | { ok: true }
  | { ok: false; reason: 'no-task' | 'running' }
  | { ok: false; reason: 'settings-problems'; problems: SessionSettingsProblem[]; message: string }

export type SetScheduleResult =
  | { ok: true; task: AgentTask }
  | { ok: false; reason: 'no-task' | 'persist-failed' }
  | { ok: false; reason: 'invalid'; problem: ScheduleProblem }

export type TaskScheduleState = Pick<AgentTask, 'schedule' | 'nextRunAt'>

type RunEnd = Pick<AgentTaskOutcome, 'kind' | 'stepIndex' | 'message'>

type OutcomeFields = Omit<AgentTaskOutcome, 'at'>

export const useAgentTasks = defineStore('agentTasks', () => {
  const agentMode = useAgentMode()
  const errors = useErrors()
  const i18n = useI18N()

  const tasks = ref<AgentTask[]>([])

  const runs = ref<Record<string, TaskRun>>({})
  /** The Task as its run started, and the abort that keeps an ended run from sending a Step. */
  const runContexts: Record<string, { plan: AgentTask; abort: AbortController }> = {}

  async function init(): Promise<void> {
    try {
      const result = await window.electronAPI.agentMode.readTasks()
      if (!result.success) throw new Error(result.error)
      tasks.value = result.tasks
    } catch (error) {
      reportReadFailure(error)
      return
    }
    await settleInterruptedRuns()
  }

  /** A Task still marked as running was cut off by the app closing; runs are not resumed. */
  async function settleInterruptedRuns(): Promise<void> {
    for (const task of tasks.value) {
      if (!task.activeRun) continue
      const { sessionId, stepIndex, stepCount } = task.activeRun
      await recordOutcome(task.id, {
        kind: 'failed',
        sessionId,
        stepIndex,
        stepCount,
        reason: 'app-closed',
      })
    }
  }

  function reportReadFailure(error: unknown): void {
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

  /** The Open Session's user messages as Step prompts, "not run" ones included. */
  function stepsFromSession(): string[] {
    return agentMode.messages
      .filter((message) => message.role === 'user')
      .map((message) => userMessagePrompt(message))
  }

  function saveBlocker(draft: TaskDraft): SaveTaskBlocker | null {
    return blockerOf({ ...draft, workspaceDir: agentMode.workspaceDir })
  }

  function blockerOf(draft: TaskDraft & { workspaceDir: string }): SaveTaskBlocker | null {
    if (!draft.name.trim()) return 'name'
    if (draft.steps.length === 0) return 'no-steps'
    if (draft.steps.some((step) => !step.prompt.trim())) return 'empty-step'
    if (!draft.workspaceDir) return 'no-folder'
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
    if (editing.value?.taskId === id) editing.value = null
    return true
  }

  /** Set, replace, pause or resume a Task's Schedule; the Next Run is kept only while enabled. */
  async function setSchedule(id: string, schedule: AgentTaskSchedule): Promise<SetScheduleResult> {
    const problem = scheduleProblem(schedule)
    if (problem) return { ok: false, reason: 'invalid', problem }
    return writeSchedule(id, {
      schedule: { ...schedule },
      ...(schedule.enabled ? { nextRunAt: nextSlotAfter(schedule, Date.now()) } : {}),
    })
  }

  async function removeSchedule(id: string): Promise<boolean> {
    return (await writeSchedule(id, {})).ok
  }

  async function writeSchedule(id: string, fields: TaskScheduleState): Promise<SetScheduleResult> {
    const saved = tasks.value.find((entry) => entry.id === id)
    if (!saved) return { ok: false, reason: 'no-task' }
    // Applied before the write, so a run marking or settling the Task meanwhile writes it too.
    const task = replaceTask({ ...withoutSchedule(saved), ...fields })
    if (await persistTask(task)) return { ok: true, task }
    const latest = tasks.value.find((entry) => entry.id === id)
    if (latest) replaceTask({ ...withoutSchedule(latest), ...scheduleStateOf(saved) })
    return { ok: false, reason: 'persist-failed' }
  }

  function withoutSchedule(task: AgentTask): AgentTask {
    const { schedule: _schedule, nextRunAt: _nextRunAt, ...rest } = task
    return rest
  }

  function scheduleStateOf(task: AgentTask): TaskScheduleState {
    return {
      ...(task.schedule ? { schedule: task.schedule } : {}),
      ...(task.nextRunAt !== undefined ? { nextRunAt: task.nextRunAt } : {}),
    }
  }

  function taskSchedule(id: string): TaskScheduleState {
    const task = tasks.value.find((entry) => entry.id === id)
    return task ? scheduleStateOf(task) : {}
  }

  function taskState(id: string): TaskState {
    const run = runs.value[id]
    if (run) return { running: { ...run } }
    return { idle: tasks.value.find((task) => task.id === id)?.lastOutcome }
  }

  /** What in the Task's Settings Template cannot be used right now; empty when it can run. */
  function taskProblems(id: string): SessionSettingsProblem[] {
    const task = tasks.value.find((entry) => entry.id === id)
    return task ? agentMode.problemsOf(task.settingsTemplate) : []
  }

  /** List the MCP servers the Tasks use, so their problems include missing servers. */
  async function loadProblemSources(): Promise<void> {
    await agentMode.loadMcpServersFor(
      tasks.value.flatMap((task) => task.settingsTemplate.capabilities ?? []),
    )
  }

  /**
   * Start a Task Run in the background: a new Task Session on the Task's folder and Settings
   * Template, its Steps sent one by one as each previous turn settles. Refused while the
   * Settings Template has a problem, before any Task Session exists.
   */
  async function runTask(id: string): Promise<RunTaskResult> {
    const capabilities = tasks.value.find((entry) => entry.id === id)?.settingsTemplate.capabilities
    await agentMode.loadMcpServersFor(capabilities ?? [])
    // Looked up after the wait, which a delete or a second Run may have overtaken.
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return { ok: false, reason: 'no-task' }
    if (runs.value[id]) return { ok: false, reason: 'running' }
    const problems = taskProblems(id)
    if (problems.length > 0) {
      const message = describeSettingsProblems(problems, i18n.state)
      return { ok: false, reason: 'settings-problems', problems, message }
    }
    const plan = cloneForIpc(task)
    const sessionId = agentMode.createSession({
      workspaceDir: plan.workspaceDir,
      settings: cloneForIpc(plan.settingsTemplate),
      presetName: AGENT_PRESET,
      title: plan.name,
      taskId: plan.id,
    })
    runContexts[id] = { plan, abort: new AbortController() }
    runs.value = { ...runs.value, [id]: { sessionId, stepIndex: 1, stepCount: plan.steps.length } }
    void sendStep(id, 1)
    return { ok: true }
  }

  async function sendStep(taskId: string, stepIndex: number): Promise<void> {
    const run = runs.value[taskId]
    const context = runContexts[taskId]
    if (!run || !context) return
    const { plan, abort } = context
    runs.value = { ...runs.value, [taskId]: { ...run, stepIndex } }
    markRunInFlight(taskId, { sessionId: run.sessionId, stepIndex, stepCount: run.stepCount })
    const result = await agentMode.sendToSession(run.sessionId, plan.steps[stepIndex - 1].prompt, {
      settings: cloneForIpc(plan.settingsTemplate),
      signal: abort.signal,
      quietErrors: true,
    })
    if (!result.ok && result.reason !== 'aborted') {
      await settleRun(taskId, { kind: 'failed', stepIndex, message: result.message })
    }
  }

  function markRunInFlight(taskId: string, activeRun: AgentTaskActiveRun): void {
    const task = tasks.value.find((entry) => entry.id === taskId)
    if (task) void persistTask(replaceTask({ ...task, activeRun }))
  }

  function replaceTask(updated: AgentTask): AgentTask {
    tasks.value = tasks.value.map((entry) => (entry.id === updated.id ? updated : entry))
    return updated
  }

  async function stopTask(id: string): Promise<void> {
    const run = runs.value[id]
    if (!run) return
    // Settled first, so the stopped turn's own settle finds no run and no Step can follow.
    const settled = settleRun(id, { kind: 'stopped', stepIndex: run.stepIndex })
    await agentMode.stopSession(run.sessionId)
    await settled
  }

  function runOfSession(sessionId: string): string | undefined {
    return Object.keys(runs.value).find((id) => runs.value[id].sessionId === sessionId)
  }

  function isSessionLockedByTask(sessionId: string): boolean {
    return runOfSession(sessionId) !== undefined
  }

  function taskLockingSession(sessionId: string): AgentTask | undefined {
    const taskId = runOfSession(sessionId)
    return taskId ? tasks.value.find((task) => task.id === taskId) : undefined
  }

  /** The Task the Open Session was created by, while that Task still exists. */
  const openSessionTask = computed(() => {
    const taskId = agentMode.sessions[agentMode.openSessionId]?.taskId
    return taskId ? tasks.value.find((task) => task.id === taskId) : undefined
  })

  /** The Open Session's Steps run with its Task's Settings Template, so its own are not editable. */
  const openSessionSettingsReadOnly = computed(() => isSessionLockedByTask(agentMode.openSessionId))

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
    runContexts[taskId]?.abort.abort()
    delete runContexts[taskId]
    await recordOutcome(taskId, { ...end, sessionId: run.sessionId, stepCount: run.stepCount })
  }

  async function recordOutcome(taskId: string, fields: OutcomeFields): Promise<void> {
    const task = tasks.value.find((entry) => entry.id === taskId)
    if (!task) return
    if (fields.kind === 'failed') reportRunFailure(task, fields)
    const lastOutcome: AgentTaskOutcome = {
      kind: fields.kind,
      at: Date.now(),
      sessionId: fields.sessionId,
      stepCount: fields.stepCount,
      ...(fields.stepIndex !== undefined ? { stepIndex: fields.stepIndex } : {}),
      ...(fields.message !== undefined ? { message: fields.message } : {}),
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
    }
    const { activeRun: _activeRun, ...rest } = task
    await persistTask(replaceTask({ ...rest, lastOutcome }))
  }

  /** A failed run is shown as the Task's outcome, so the sink only records it. */
  function reportRunFailure(task: AgentTask, end: OutcomeFields): void {
    const message = end.message ?? end.reason ?? ''
    errors.report(
      createAppError({
        category: 'inference',
        code: 'agent-tasks/run-failed',
        severity: 'warning',
        surface: 'silent',
        userMessage: message,
        technicalMessage: `Task "${task.name}" failed at step ${end.stepIndex ?? '?'}: ${message}`,
        context: { taskId: task.id, stepIndex: end.stepIndex },
      }),
    )
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
    draft.value.steps = withStepAdded(draft.value.steps)
  }

  function removeStep(id: string): void {
    draft.value.steps = withStepRemoved(draft.value.steps, id)
  }

  function moveStep(id: string, direction: 'up' | 'down'): void {
    draft.value.steps = withStepMoved(draft.value.steps, id, direction)
  }

  async function saveDraft(): Promise<SaveTaskResult> {
    const result = await saveTask(draft.value)
    if (result.ok) draft.value = emptyDraft()
    return result
  }

  // A saved Task being edited in task mode; memory only, one at a time.
  const editing = ref<{ taskId: string; draft: TaskEditDraft } | null>(null)

  const editingTaskId = computed(() => editing.value?.taskId ?? null)
  const editDraft = computed(() => editing.value?.draft ?? null)
  /** The saved version of the Task being edited. */
  const editedTask = computed(() =>
    editing.value ? tasks.value.find((task) => task.id === editing.value?.taskId) : undefined,
  )

  function editDraftOf(task: AgentTask): TaskEditDraft {
    return cloneForIpc({
      name: task.name,
      workspaceDir: task.workspaceDir,
      steps: task.steps.map((step) => ({ id: step.id, prompt: step.prompt })),
      settingsTemplate: task.settingsTemplate,
    })
  }

  const editDirty = computed(() => {
    const current = editing.value
    if (!current) return false
    const saved = tasks.value.find((task) => task.id === current.taskId)
    if (!saved) return false
    return JSON.stringify(current.draft) !== JSON.stringify(editDraftOf(saved))
  })

  /** Clone the Task into the edit draft, replacing any edit in progress. */
  function beginEdit(id: string): boolean {
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return false
    editing.value = { taskId: id, draft: editDraftOf(task) }
    return true
  }

  const editBlocker = computed(() => (editing.value ? blockerOf(editing.value.draft) : null))

  /** What in the draft's Settings Template cannot be used right now; never blocks Save. */
  const editProblems = computed<SessionSettingsProblem[]>(() =>
    editing.value ? agentMode.problemsOf(editing.value.draft.settingsTemplate) : [],
  )

  /** Change fields of the draft's Settings Template; nothing outside the draft is written. */
  function editTemplate(change: AgentSessionSettings): void {
    const draft = editing.value?.draft
    if (draft) draft.settingsTemplate = { ...draft.settingsTemplate, ...change }
  }

  /**
   * Upsert the edited Task by id and end the edit. A run in flight keeps the copy it took
   * at start, so the saved version applies from the next run.
   */
  async function saveEdit(): Promise<SaveTaskResult> {
    const current = editing.value
    const saved = current && tasks.value.find((task) => task.id === current.taskId)
    if (!current || !saved) return { ok: false, reason: 'no-task' }
    const blocker = blockerOf(current.draft)
    if (blocker) return { ok: false, reason: blocker }
    const edited = cloneForIpc(current.draft)
    const task = replaceTask({
      ...saved,
      name: edited.name.trim(),
      workspaceDir: edited.workspaceDir,
      steps: edited.steps.map((step) => ({ id: step.id, prompt: step.prompt })),
      settingsTemplate: cloneForIpc(edited.settingsTemplate),
      updatedAt: Math.max(Date.now(), saved.updatedAt + 1),
    })
    // Applied before the write, so a run marking or settling the Task meanwhile writes it too.
    if (!(await persistTask(task))) {
      restoreEditableFields(saved)
      return { ok: false, reason: 'persist-failed' }
    }
    // Typing during the write keeps the edit open, with what was typed still unsaved.
    const untouched = JSON.stringify(current.draft) === JSON.stringify(edited)
    if (editing.value === current && untouched) editing.value = null
    return { ok: true, task }
  }

  function restoreEditableFields(saved: AgentTask): void {
    const latest = tasks.value.find((entry) => entry.id === saved.id)
    if (!latest) return
    const { name, workspaceDir, steps, settingsTemplate, updatedAt } = saved
    replaceTask({ ...latest, name, workspaceDir, steps, settingsTemplate, updatedAt })
  }

  function discardEdit(): void {
    editing.value = null
  }

  return {
    tasks,
    init,
    stepsFromSession,
    saveBlocker,
    saveTask,
    deleteTask,
    setSchedule,
    removeSchedule,
    taskSchedule,
    taskState,
    taskProblems,
    loadProblemSources,
    runTask,
    stopTask,
    isSessionLockedByTask,
    taskLockingSession,
    openSessionTask,
    openSessionSettingsReadOnly,
    draft,
    draftBlocker,
    draftTemplate,
    createStepsFromSession,
    addStep,
    removeStep,
    moveStep,
    saveDraft,
    editingTaskId,
    editDraft,
    editedTask,
    editDirty,
    beginEdit,
    editBlocker,
    editTemplate,
    editProblems,
    saveEdit,
    discardEdit,
  }
})

if (import.meta.hot) import.meta.hot.accept(acceptHMRUpdate(useAgentTasks, import.meta.hot))
