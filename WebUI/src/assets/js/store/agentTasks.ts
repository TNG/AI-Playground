import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { MODEL_DOWNLOAD_DECLINED, promptHasImageAttachment } from '@/types/agentIpc'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { PauseReason } from '@/types/kernelEvents'
import type {
  AgentTask,
  AgentTaskActiveRun,
  AgentTaskOutcome,
  AgentTaskSchedule,
  AgentTaskStep,
} from '@/types/agentTaskIpc'
import { MCP_CAPABILITY_PREFIX } from '@/types/agentCapabilities'
import { useActivities } from './activities'
import { useAgentMode, type SessionTurnInfo } from './agentMode'
import { AGENT_PRESET } from './agentModeSessions'
import { userMessagePrompt } from './agentModeTurn'
import { useDemoMode } from './demoMode'
import { useErrors } from './errors'
import { useI18N } from './i18n'
import { useMcp } from './mcp'
import { usePresets } from './presets'
import { useTextInference } from './textInference'
import { createAppError, extractMessage, isCancellation } from '@/assets/js/errors/appError'
import { requestDownload } from '@/assets/js/permissions/permissions'
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

/**
 * A Task Run in flight; `stepIndex` is 1-based. `skippedSlots` counts the Schedule slots that
 * passed while its Task Session was paused. Memory only.
 */
export type TaskRun = {
  stepIndex: number
  stepCount: number
  sessionId: string
  skippedSlots?: number
}

/** A Task Run as shown: `paused` while its Task Session waits on the user. */
export type TaskRunState = TaskRun & { paused?: { reason?: PauseReason } }

export type TaskState = { running: TaskRunState } | { idle: AgentTaskOutcome | undefined }

/** The chat model a Settings Template runs on was not downloaded. */
export type ModelDownloadRefusal =
  { reason: 'download-declined' } | { reason: 'download-failed'; error: string }

export type SaveTaskResult =
  | { ok: true; task: AgentTask }
  | { ok: false; reason: SaveTaskBlocker | 'persist-failed' | 'no-task' }
  | ({ ok: false; message: string } & ModelDownloadRefusal)

export type RunTaskResult =
  | { ok: true }
  | { ok: false; reason: 'no-task' | 'running' }
  | { ok: false; reason: 'settings-problems'; problems: SessionSettingsProblem[]; message: string }
  | ({ ok: false; message: string } & ModelDownloadRefusal)

export type SetScheduleResult =
  | { ok: true; task: AgentTask }
  | { ok: false; reason: 'no-task' | 'persist-failed' }
  | { ok: false; reason: 'invalid'; problem: ScheduleProblem }

export type TaskScheduleState = Pick<AgentTask, 'schedule' | 'nextRunAt'>

type RunEnd = Pick<AgentTaskOutcome, 'kind' | 'stepIndex' | 'message'>

type OutcomeFields = Omit<AgentTaskOutcome, 'at'>

type ScheduledTask = AgentTask & { schedule: AgentTaskSchedule }

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (result, [name, value]) => result.replace(`{${name}}`, String(value)),
    template,
  )
}

const SCHEDULE_TICK_MS = 30_000
/**
 * A due slot older than this was missed (app closed, machine asleep) and is not run. The margin
 * covers Chromium aligning a hidden window's timers to one wake-up a minute.
 */
const FRESH_SLOT_MS = SCHEDULE_TICK_MS + 60_000

export const useAgentTasks = defineStore('agentTasks', () => {
  const activities = useActivities()
  const agentMode = useAgentMode()
  const demoMode = useDemoMode()
  const errors = useErrors()
  const i18n = useI18N()
  const mcp = useMcp()
  const presets = usePresets()
  const textInference = useTextInference()

  const tasks = ref<AgentTask[]>([])

  const runs = ref<Record<string, TaskRun>>({})
  /** The Task as its run started, and the abort that keeps an ended run from sending a Step. */
  const runContexts: Record<
    string,
    { plan: AgentTask; abort: AbortController; scheduled: boolean }
  > = {}

  // Closing the window hides the app instead, so Schedules keep firing and no run is cut off.
  watch(
    () =>
      Object.keys(runs.value).length > 0 ||
      (!demoMode.enabled && tasks.value.some((task) => task.schedule?.enabled === true)),
    (busy) => activities.holdBusy('agent-tasks', busy),
    { immediate: true },
  )

  let scheduleTicker: ReturnType<typeof setInterval> | undefined
  /** Tasks whose delete is in flight; a tick saving one would write it back. */
  const deleting = new Set<string>()
  /** Tasks whose ▶ Run is still being checked, possibly waiting on a model download. */
  const starting = new Set<string>()

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
    skipMissedSlots()
    clearInterval(scheduleTicker)
    scheduleTicker = setInterval(tickSchedules, SCHEDULE_TICK_MS)
  }

  /** No catch-up at launch: slots that fell while the app was closed are skipped. */
  function skipMissedSlots(): void {
    const now = Date.now()
    for (const task of tasks.value) {
      if (isDue(task, now)) advanceNextRun(task, now)
    }
  }

  function tickSchedules(): void {
    if (demoMode.enabled) return
    const now = Date.now()
    for (const task of tasks.value) {
      if (!isDue(task, now) || deleting.has(task.id)) continue
      const fresh = task.nextRunAt !== undefined && now - task.nextRunAt < FRESH_SLOT_MS
      advanceNextRun(task, now)
      if (!fresh) continue
      // One Task Run at a time: a slot that finds one in flight is skipped, not queued.
      const run = runs.value[task.id]
      if (!run) void runScheduled(task.id)
      else if (pausedTurnOf(run)) countSkippedSlot(task.id)
    }
  }

  function pausedTurnOf(run: TaskRun): SessionTurnInfo | undefined {
    const turn = agentMode.sessionTurns[run.sessionId]
    return turn?.state === 'paused' ? turn : undefined
  }

  function countSkippedSlot(taskId: string): void {
    const run = runs.value[taskId]
    const skippedSlots = (run.skippedSlots ?? 0) + 1
    runs.value = { ...runs.value, [taskId]: { ...run, skippedSlots } }
  }

  function isDue(task: AgentTask, now: number): task is ScheduledTask {
    return (
      task.schedule?.enabled === true && !(task.nextRunAt !== undefined && task.nextRunAt > now)
    )
  }

  function advanceNextRun(task: ScheduledTask, now: number): void {
    void persistTask(replaceTask({ ...task, nextRunAt: nextSlotAfter(task.schedule, now) }))
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

  type DownloadRefusalText = { declined: string; failed: string; surface: 'inline' | 'toast' }

  const saveRefusalText = (): DownloadRefusalText => ({
    declined:
      i18n.state.AGENT_TASK_SAVE_DOWNLOAD_DECLINED ??
      'Not saved: the task’s chat model {model} has to be downloaded first.',
    failed:
      i18n.state.AGENT_TASK_SAVE_DOWNLOAD_FAILED ??
      'Not saved: the download of {model} failed: {error}',
    surface: 'inline',
  })

  const runRefusalText = (): DownloadRefusalText => ({
    declined:
      i18n.state.AGENT_TASK_RUN_DOWNLOAD_DECLINED ??
      'Not started: the task’s chat model {model} has to be downloaded first.',
    failed:
      i18n.state.AGENT_TASK_RUN_DOWNLOAD_FAILED ??
      'Not started: the download of {model} failed: {error}',
    surface: 'toast',
  })

  /**
   * The Task's local chat model, with its vision projector when a Step hands it an image, is
   * downloaded with the user's consent when missing; a refusal says why it is not on disk.
   */
  async function chatModelRefusal(
    template: AgentSessionSettings,
    steps: readonly AgentTaskStep[],
    text: DownloadRefusalText,
  ): Promise<(ModelDownloadRefusal & { message: string }) | null> {
    const { inference } = textInference.inferenceForSettings(AGENT_PRESET, template)
    if (inference.backend === 'cloud') return null
    const model = inference.activeModel ?? ''
    const needsVision =
      inference.modelSupportsVision && steps.some((step) => promptHasImageAttachment(step.prompt))
    try {
      const missing = await textInference.getMissingLlmModels(
        inference.backend as 'llamaCPP' | 'openVINO',
        model,
        { needsVision },
      )
      if (missing.length > 0) await requestDownload(missing)
      return null
    } catch (error) {
      if (isCancellation(error)) {
        return { reason: 'download-declined', message: fill(text.declined, { model }) }
      }
      const technical = extractMessage(error)
      const message = fill(text.failed, { model, error: technical })
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-tasks/model-download-failed',
          severity: 'warning',
          surface: text.surface,
          userMessage: message,
          technicalMessage: technical,
          cause: error,
        }),
      )
      return { reason: 'download-failed', error: technical, message }
    }
  }

  async function saveRefusal(
    template: AgentSessionSettings,
    steps: readonly AgentTaskStep[],
  ): Promise<SaveTaskResult | null> {
    const refusal = await chatModelRefusal(template, steps, saveRefusalText())
    return refusal && { ok: false, ...refusal }
  }

  /** Store the draft with the Open Session's folder and the panel's Session Settings. */
  async function saveTask(draft: TaskDraft): Promise<SaveTaskResult> {
    const blocker = saveBlocker(draft)
    if (blocker) return { ok: false, reason: blocker }
    const name = draft.name.trim()
    const workspaceDir = agentMode.workspaceDir
    const settingsTemplate = cloneForIpc(agentMode.openSessionSettings)
    const steps = draft.steps.map((step) => ({ id: step.id, prompt: step.prompt }))
    const refusal = await saveRefusal(settingsTemplate, steps)
    if (refusal) return refusal
    const now = Date.now()
    const task: AgentTask = {
      id: crypto.randomUUID(),
      name,
      workspaceDir,
      settingsTemplate,
      steps,
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
    deleting.add(id)
    const result = await window.electronAPI.agentMode
      .deleteTask(id)
      .catch((error: unknown) => ({ success: false as const, error: String(error) }))
      .finally(() => deleting.delete(id))
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
    if (run) {
      const turn = pausedTurnOf(run)
      if (!turn) return { running: { ...run } }
      const reason = turn.pauseReason
      return { running: { ...run, paused: reason ? { reason } : {} } }
    }
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
   * Template, its Steps sent one by one as each previous turn settles. Refused, before any Task
   * Session exists, while the Settings Template has a problem or its chat model is not downloaded.
   */
  async function runTask(id: string): Promise<RunTaskResult> {
    if (starting.has(id)) return { ok: false, reason: 'running' }
    starting.add(id)
    try {
      return await startManualRun(id)
    } finally {
      starting.delete(id)
    }
  }

  async function startManualRun(id: string): Promise<RunTaskResult> {
    const capabilities = tasks.value.find((entry) => entry.id === id)?.settingsTemplate.capabilities
    await agentMode.loadMcpServersFor(capabilities ?? [])
    // Looked up after the wait, which a delete or a second Run may have overtaken.
    const checked = tasks.value.find((entry) => entry.id === id)
    if (!checked) return { ok: false, reason: 'no-task' }
    if (runs.value[id]) return { ok: false, reason: 'running' }
    const problems = taskProblems(id)
    if (problems.length > 0) {
      const message = describeSettingsProblems(problems, i18n.state)
      return { ok: false, reason: 'settings-problems', problems, message }
    }
    const refusal = await chatModelRefusal(
      checked.settingsTemplate,
      checked.steps,
      runRefusalText(),
    )
    if (refusal) return { ok: false, ...refusal }
    // The download may have taken long enough for a delete or a Scheduled Run to overtake it.
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task) return { ok: false, reason: 'no-task' }
    if (runs.value[id]) return { ok: false, reason: 'running' }
    startRun(task, false)
    return { ok: true }
  }

  /**
   * A Task Run started by the Schedule. Nobody is watching, so a refusal is kept as the Task's
   * outcome and toasted; a Task Run already in flight skips the slot silently.
   */
  async function runScheduled(id: string): Promise<void> {
    const slotTask = stillScheduled(id)
    if (!slotTask) return
    await agentMode.loadMcpServersFor(slotTask.settingsTemplate.capabilities ?? [])
    const folderFound = await folderExists(slotTask.workspaceDir)
    // A delete, pause or manual Run may have overtaken the waits.
    const task = stillScheduled(id)
    if (!task) return
    const refusal = scheduledRefusal(task, folderFound)
    if (!refusal) return startRun(task, true)
    await recordOutcome(
      id,
      { kind: 'failed', reason: 'not-started', message: refusal, stepCount: task.steps.length },
      true,
    )
  }

  function stillScheduled(id: string): AgentTask | undefined {
    const task = tasks.value.find((entry) => entry.id === id)
    if (!task?.schedule?.enabled || runs.value[id] || starting.has(id) || deleting.has(id)) {
      return undefined
    }
    return task
  }

  async function folderExists(dir: string): Promise<boolean> {
    if (!dir) return false
    return (await window.electronAPI.existsPath(dir).catch(() => false)) === true
  }

  function scheduledRefusal(task: AgentTask, folderFound: boolean): string | null {
    if (!presets.presets.some((preset) => preset.name === AGENT_PRESET)) {
      return i18n.state.AGENT_TASK_PRESET_UNAVAILABLE ?? 'The Agent preset is not available.'
    }
    const needsMcp = (task.settingsTemplate.capabilities ?? []).some((id) =>
      id.startsWith(MCP_CAPABILITY_PREFIX),
    )
    if (needsMcp && !mcp.serversLoaded) {
      return fill(
        i18n.state.AGENT_TASK_MCP_UNAVAILABLE ?? 'The MCP servers could not be loaded: {error}',
        { error: mcp.configError ?? '' },
      )
    }
    const problems = taskProblems(task.id)
    if (problems.length > 0) return describeSettingsProblems(problems, i18n.state)
    if (!folderFound) {
      return fill(
        i18n.state.AGENT_WORKSPACE_FOLDER_MISSING ?? 'The workspace folder is missing: {path}',
        { path: task.workspaceDir },
      )
    }
    return null
  }

  function startRun(task: AgentTask, scheduled: boolean): void {
    const id = task.id
    const plan = cloneForIpc(task)
    const sessionId = agentMode.createSession({
      workspaceDir: plan.workspaceDir,
      settings: cloneForIpc(plan.settingsTemplate),
      presetName: AGENT_PRESET,
      title: plan.name,
      taskId: plan.id,
    })
    runContexts[id] = { plan, abort: new AbortController(), scheduled }
    runs.value = { ...runs.value, [id]: { sessionId, stepIndex: 1, stepCount: plan.steps.length } }
    void sendStep(id, 1)
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
    const scheduled = runContexts[taskId]?.scheduled === true
    runContexts[taskId]?.abort.abort()
    delete runContexts[taskId]
    const declined = end.kind === 'failed' && end.message === MODEL_DOWNLOAD_DECLINED
    await recordOutcome(
      taskId,
      {
        ...end,
        sessionId: run.sessionId,
        stepCount: run.stepCount,
        ...(declined ? { reason: 'download-declined' as const } : {}),
      },
      scheduled,
    )
  }

  async function recordOutcome(
    taskId: string,
    fields: OutcomeFields,
    scheduled = false,
  ): Promise<void> {
    const task = tasks.value.find((entry) => entry.id === taskId)
    if (!task) return
    if (fields.kind === 'failed') reportRunFailure(task, fields, scheduled)
    const lastOutcome: AgentTaskOutcome = {
      kind: fields.kind,
      at: Date.now(),
      ...(fields.sessionId !== undefined ? { sessionId: fields.sessionId } : {}),
      stepCount: fields.stepCount,
      ...(fields.stepIndex !== undefined ? { stepIndex: fields.stepIndex } : {}),
      ...(fields.message !== undefined ? { message: fields.message } : {}),
      ...(fields.reason !== undefined ? { reason: fields.reason } : {}),
    }
    const { activeRun: _activeRun, ...rest } = task
    await persistTask(replaceTask({ ...rest, lastOutcome }))
  }

  /** The outcome shows a failed run, so only a Scheduled Run, which nobody watched, is toasted. */
  function reportRunFailure(task: AgentTask, end: OutcomeFields, scheduled: boolean): void {
    const declined =
      end.reason === 'download-declined' ? i18n.state.AGENT_TASKS_OUTCOME_DOWNLOAD_DECLINED : null
    const message = declined ?? end.message ?? end.reason ?? ''
    if (scheduled) {
      const notStarted = end.reason === 'not-started'
      const report = notStarted
        ? {
            category: 'validation' as const,
            code: 'agent-tasks/scheduled-run-not-started',
            template:
              i18n.state.AGENT_TASK_SCHEDULED_RUN_NOT_STARTED ??
              'The scheduled run of “{name}” could not start: {reason}',
          }
        : {
            category: 'inference' as const,
            code: 'agent-tasks/scheduled-run-failed',
            template:
              i18n.state.AGENT_TASK_SCHEDULED_RUN_FAILED ??
              'The scheduled run of “{name}” failed: {reason}',
          }
      const userMessage = fill(report.template, { name: task.name, reason: message })
      errors.report(
        createAppError({
          category: report.category,
          code: report.code,
          severity: 'warning',
          surface: 'toast',
          userMessage,
          technicalMessage: `Task "${task.name}" at step ${end.stepIndex ?? '-'}: ${userMessage}`,
          context: { taskId: task.id, stepIndex: end.stepIndex },
        }),
      )
      return
    }
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
    const saving = draft.value
    const snapshot = JSON.stringify(saving)
    const result = await saveTask(saving)
    // Typing during the model download keeps the draft, with what was typed still unsaved.
    if (result.ok && draft.value === saving && JSON.stringify(saving) === snapshot) {
      draft.value = emptyDraft()
    }
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
    if (!current || !tasks.value.some((task) => task.id === current.taskId)) {
      return { ok: false, reason: 'no-task' }
    }
    const blocker = blockerOf(current.draft)
    if (blocker) return { ok: false, reason: blocker }
    const edited = cloneForIpc(current.draft)
    const refusal = await saveRefusal(edited.settingsTemplate, edited.steps)
    if (refusal) return refusal
    // Read after the download, which a delete or a run settling may have overtaken.
    const saved = tasks.value.find((task) => task.id === current.taskId)
    if (!saved) return { ok: false, reason: 'no-task' }
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
