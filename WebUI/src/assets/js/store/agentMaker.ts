import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useErrors } from './errors'
import { useAgentMode } from './agentMode'
import { usePresets, type ChatPreset } from './presets'
import { usePresetSwitching } from './presetSwitching'
import { useTextInference } from './textInference'
import { useCloudMode } from './cloudMode'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import { usePromptStore } from './promptArea'
import { useDemoMode } from './demoMode'
import { AGENT_PRESET, type AgentSessionRecord } from './agentModeSessions'
import { buildTaskTurnConfig } from './agentModeTurn'
import { requestDownload } from '@/assets/js/permissions/permissions'
import { isCancellation } from '@/assets/js/errors/appError'
import { cloneForIpc } from '@/lib/cloneForIpc'
import {
  resolveTaskEmbedding,
  resolveTaskModel,
  type TaskModelEnvironment,
} from '@/lib/agentTaskModel'
import { decideScheduledRun, isTaskDue, runsToPrune, taskNextRunAt } from '@/lib/agentTaskSchedule'
import type { AgentTask } from '@/types/agentMakerIpc'

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

export type RunTrigger = 'manual' | 'schedule'

export type ScheduleSkipReason = 'busy' | 'agent-in-use'

const SCHEDULER_TICK_MS = 30_000
let schedulerTimer: ReturnType<typeof setInterval> | null = null

const MODEL_NOT_DOWNLOADED = 'Model not downloaded. Run the task manually once to download it.'

export type ActiveAgentRun = {
  taskId: string
  sessionId: string
  stepIndex: number
  stepCount: number
}

/**
 * Agent Maker: task definitions (kernel-owned files via `agentMaker:*`) and the
 * renderer-driven step loop. A run is an agent session tagged `origin:
 * 'agentMaker'`; every turn of it — the steps and anything the user asks
 * afterwards — is built from its task through the builder registered on the
 * agentMode store, never from Agent Settings.
 */
export const useAgentMaker = defineStore('agentMaker', () => {
  const errors = useErrors()
  const agentMode = useAgentMode()
  const presets = usePresets()
  const presetSwitching = usePresetSwitching()
  const textInference = useTextInference()
  const cloudMode = useCloudMode()
  const backendServices = useBackendServices()
  const models = useModels()
  const promptStore = usePromptStore()
  const demoMode = useDemoMode()

  const tasks = ref<AgentTask[]>([])
  const hydrated = ref(false)
  const activeRun = ref<ActiveAgentRun | null>(null)
  /** Task whose run history the Agent Maker view opens on (set by "Back to Agent Maker"). */
  const focusTaskId = ref<string | null>(null)
  let stopRequested = false
  /** Covers the awaits before `activeRun` is set, so two starts cannot overlap. */
  const starting = ref(false)
  /** When the scheduler started watching each task's schedule; earlier times are not caught up. */
  const armedAt: Record<string, number> = {}
  /** Why a task's last scheduled time did not run (in memory only). */
  const scheduleSkips = ref<Record<string, ScheduleSkipReason>>({})
  let ticking = false

  async function init(): Promise<void> {
    if (hydrated.value) return
    try {
      const result = await window.electronAPI.agentMaker.bootstrap()
      if (result.status === 'ok') tasks.value = result.tasks
      else if (result.status === 'error') throw new Error(result.error)
    } catch (error) {
      errors.report(error, {
        category: 'backend',
        code: 'agent-maker/bootstrap-failed',
        userMessage: 'Could not load Agent Maker tasks.',
        surface: 'silent',
      })
    }
    hydrated.value = true
    startScheduler()
  }

  function findTask(id: string): AgentTask | undefined {
    return tasks.value.find((t) => t.id === id)
  }

  /** The task behind the active agent session, when that session is a run. */
  const activeSessionTask = computed<AgentTask | null>(() => {
    const taskId = agentMode.activeTaskRunId
    return taskId ? (findTask(taskId) ?? null) : null
  })

  async function taskEnvironment(task: AgentTask): Promise<TaskModelEnvironment> {
    return {
      catalog: textInference.llmModels.filter((m) => m.type !== 'cloud'),
      embeddingModels: textInference.llmEmbeddingModels,
      services: backendServices.info,
      cloudProviders: cloudMode.providers,
      cloudProxyUrl: task.model.backend === 'cloud' ? await cloudMode.ensureProxyUrl() : undefined,
    }
  }

  agentMode.setTaskRunTurnConfigBuilder(async ({ taskId, sessionId, workspaceDir }) => {
    const task = findTask(taskId)
    if (!task) throw new Error('The task this run belongs to no longer exists.')
    const env = await taskEnvironment(task)
    return buildTaskTurnConfig({
      sessionId,
      workspaceDir,
      task,
      resolved: resolveTaskModel(task.model, env),
      embedding: resolveTaskEmbedding(task.model, task.capabilities, env),
      presetName: AGENT_PRESET,
    })
  })

  async function saveTask(task: AgentTask): Promise<boolean> {
    const previous = findTask(task.id)
    const result = await window.electronAPI.agentMaker.save(cloneForIpc(task))
    if (!result.success) {
      errors.report(new Error(result.error), {
        category: 'unknown',
        code: 'agent-maker/save-failed',
        userMessage: `Could not save the task: ${result.error}`,
        surface: 'toast',
      })
      return false
    }
    // Main derives the slug, so the stored copy is what the list should show.
    const bootstrap = await window.electronAPI.agentMaker.bootstrap()
    const saved = bootstrap.status === 'ok' ? bootstrap.tasks.find((t) => t.id === task.id) : null
    const next = saved ?? task
    tasks.value = tasks.value.some((t) => t.id === task.id)
      ? tasks.value.map((t) => (t.id === task.id ? next : t))
      : [...tasks.value, next]
    if (!previous || JSON.stringify(previous.schedule) !== JSON.stringify(next.schedule)) {
      rearm(next.id)
    }
    return true
  }

  /** Write fields that are not an edit of the task, so `updatedAt` (list order) stays. */
  async function patchTask(id: string, patch: Partial<AgentTask>): Promise<void> {
    const task = findTask(id)
    if (!task) return
    const next = { ...task, ...patch }
    tasks.value = tasks.value.map((t) => (t.id === id ? next : t))
    const result = await window.electronAPI.agentMaker.save(cloneForIpc(next))
    if (!result.success) {
      errors.report(new Error(result.error), {
        category: 'unknown',
        code: 'agent-maker/save-failed',
        userMessage: `Could not save the task: ${result.error}`,
        surface: 'silent',
      })
    }
  }

  function rearm(taskId: string): void {
    armedAt[taskId] = Date.now()
    const { [taskId]: _dropped, ...rest } = scheduleSkips.value
    scheduleSkips.value = rest
  }

  function nextScheduledRun(task: AgentTask): number | null {
    return taskNextRunAt(task, armedAt[task.id] ?? Date.now())
  }

  async function deleteTask(id: string): Promise<void> {
    if (activeRun.value?.taskId === id) return
    for (const run of taskRuns(id)) await agentMode.deleteSession(run.id)
    const result = await window.electronAPI.agentMaker.delete(id)
    if (!result.success) {
      errors.report(new Error(result.error), {
        category: 'unknown',
        code: 'agent-maker/delete-failed',
        userMessage: `Could not delete the task: ${result.error}`,
        surface: 'toast',
      })
      return
    }
    tasks.value = tasks.value.filter((t) => t.id !== id)
  }

  /** A task's runs, newest first. */
  function taskRuns(taskId: string): AgentSessionRecord[] {
    return Object.values(agentMode.sessions)
      .filter((s) => s.origin === 'agentMaker' && s.taskId === taskId)
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  /** A stored `running` with no live loop behind it was cut off by a restart. */
  function runStatus(run: AgentSessionRecord): AgentRunStatus {
    const status = run.taskRunStatus ?? 'completed'
    if (status === 'running' && activeRun.value?.sessionId !== run.id) return 'interrupted'
    return status
  }

  const canStartRun = computed(() => !activeRun.value && !starting.value && !agentMode.processing)

  function reportRunFailure(error: unknown, userMessage: string): void {
    errors.report(error, {
      category: 'inference',
      code: 'agent-maker/start-failed',
      userMessage,
      surface: 'toast',
    })
  }

  /** The task's chat model, plus its embedding model when it searches documents. */
  async function missingModels(task: AgentTask) {
    const wanted: Parameters<typeof models.checkModelAlreadyLoaded>[0] = []
    if (task.model.backend !== 'cloud') {
      const openVINO = task.model.backend === 'openVINO'
      wanted.push({
        repo_id: task.model.model,
        type: openVINO ? 'openvinoLLM' : 'ggufLLM',
        backend: openVINO ? 'openvino' : 'llama_cpp',
      })
    }
    if (task.capabilities.includes('rag') && task.model.embeddingModel) {
      wanted.push({
        repo_id: task.model.embeddingModel,
        type: 'embedding',
        backend: task.model.embeddingBackend === 'openVINO' ? 'openvino' : 'llama_cpp',
      })
    }
    if (wanted.length === 0) return []
    return (await models.checkModelAlreadyLoaded(wanted)).filter((m) => !m.already_loaded)
  }

  async function mintRun(task: AgentTask, trigger: RunTrigger) {
    const result = await window.electronAPI.agentMaker.startRun(task.id)
    if (!result.success) throw new Error(result.error)
    const now = Date.now()
    agentMode.adoptSessionRecord({
      id: result.sessionId,
      workspaceDir: result.workspaceDir,
      title: task.name,
      messages: [],
      createdAt: now,
      updatedAt: now,
      capabilities: [...task.capabilities],
      presetName: AGENT_PRESET,
      origin: 'agentMaker',
      taskId: task.id,
      taskRunStatus: 'running',
      taskRunStepIndex: 0,
      taskRunTrigger: trigger,
    })
    return result
  }

  /** A scheduled run that could not start still leaves an entry in the run history. */
  async function recordFailedRun(task: AgentTask, reason: string): Promise<void> {
    try {
      const { sessionId } = await mintRun(task, 'schedule')
      agentMode.patchSessionRecord(sessionId, { taskRunStatus: 'failed', taskRunError: reason })
      await pruneRuns(task.id, [sessionId])
    } catch (error) {
      errors.report(error, {
        category: 'inference',
        code: 'agent-maker/schedule-failed',
        userMessage: `Scheduled run of "${task.name}" failed: ${reason}`,
        surface: 'silent',
      })
    }
  }

  async function pruneRuns(taskId: string, keepIds: string[]): Promise<void> {
    const doomed = runsToPrune(taskRuns(taskId), [...keepIds, agentMode.activeSessionId])
    for (const id of doomed) {
      await agentMode.deleteSession(id)
      await window.electronAPI.agentMaker.deleteRunWorkspace(taskId, id)
    }
  }

  /** Put back the agent session the user had before a run took over the Agent view. */
  async function restoreSession(runSessionId: string, previousId: string): Promise<void> {
    if (agentMode.activeSessionId !== runSessionId) return
    if (promptStore.getCurrentMode() === 'agent') return
    if (previousId && agentMode.sessions[previousId]) {
      await agentMode.switchSession(previousId, { keepPreset: true })
    } else {
      await agentMode.startNew()
    }
  }

  /**
   * Start a run and drive its steps as consecutive turns of one session. The
   * run executes in the background of the Agent Maker view; `openRun` shows it
   * in Agent Mode. A manual run may ask to download its models; a scheduled one
   * has been checked by the scheduler and never prompts.
   */
  async function startRun(taskId: string, options: { trigger?: RunTrigger } = {}): Promise<void> {
    const trigger = options.trigger ?? 'manual'
    const task = findTask(taskId)
    if (!task || !canStartRun.value) return
    starting.value = true
    let sessionId: string
    const previousSessionId = agentMode.activeSessionId
    try {
      try {
        resolveTaskModel(task.model, await taskEnvironment(task))
        if (trigger === 'manual') {
          const missing = await missingModels(task)
          if (missing.length > 0) await requestDownload(missing)
        }
      } catch (error) {
        if (isCancellation(error)) return
        const message = (error as Error).message ?? String(error)
        if (trigger === 'schedule') await recordFailedRun(task, message)
        else reportRunFailure(error, `Could not start the run: ${message}`)
        return
      }
      try {
        sessionId = (await mintRun(task, trigger)).sessionId
      } catch (error) {
        reportRunFailure(error, `Could not start the run: ${(error as Error).message}`)
        return
      }
      stopRequested = false
      activeRun.value = { taskId, sessionId, stepIndex: 0, stepCount: task.steps.length }
    } finally {
      starting.value = false
    }

    try {
      await pruneRuns(taskId, [sessionId])
      await agentMode.switchSession(sessionId, { keepPreset: true })
      for (let i = 0; i < task.steps.length; i++) {
        if (stopRequested || agentMode.activeSessionId !== sessionId) {
          agentMode.patchSessionRecord(sessionId, { taskRunStatus: 'stopped' })
          return
        }
        activeRun.value = { ...activeRun.value, stepIndex: i }
        agentMode.patchSessionRecord(sessionId, { taskRunStepIndex: i })
        const outcome = await agentMode.generate(task.steps[i])
        if (outcome === 'stopped' || agentMode.activeSessionId !== sessionId) {
          agentMode.patchSessionRecord(sessionId, { taskRunStatus: 'stopped' })
          return
        }
        if (outcome === 'error') {
          const reason = agentMode.chat.error?.message
          agentMode.patchSessionRecord(sessionId, {
            taskRunStatus: 'failed',
            taskRunError: reason ? `Step ${i + 1}: ${reason}` : `Step ${i + 1} failed`,
          })
          return
        }
      }
      agentMode.patchSessionRecord(sessionId, { taskRunStatus: 'completed' })
    } catch (error) {
      agentMode.patchSessionRecord(sessionId, {
        taskRunStatus: 'failed',
        taskRunError: (error as Error).message ?? String(error),
      })
      reportRunFailure(error, 'The run failed.')
    } finally {
      activeRun.value = null
      stopRequested = false
      await restoreSession(sessionId, previousSessionId)
    }
  }

  // ── Scheduler ──────────────────────────────────────────────────────────────

  async function handleDueTask(task: AgentTask, runStarted: boolean): Promise<boolean> {
    await patchTask(task.id, { lastScheduledAt: Date.now() })
    let missing: Awaited<ReturnType<typeof missingModels>> = []
    let checkError: string | null = null
    try {
      missing = await missingModels(task)
    } catch (error) {
      checkError = (error as Error).message ?? String(error)
    }
    const decision = decideScheduledRun({
      runActive: runStarted || !!activeRun.value || starting.value,
      agentModeVisible: promptStore.getCurrentMode() === 'agent',
      agentTurnRunning: agentMode.processing,
      modelMissing: missing.length > 0,
    })
    if (decision.action === 'skip') {
      scheduleSkips.value = { ...scheduleSkips.value, [task.id]: decision.reason }
      return false
    }
    const { [task.id]: _cleared, ...rest } = scheduleSkips.value
    scheduleSkips.value = rest
    if (decision.action === 'fail') {
      await recordFailedRun(task, MODEL_NOT_DOWNLOADED)
      return false
    }
    if (checkError) {
      await recordFailedRun(task, checkError)
      return false
    }
    void startRun(task.id, { trigger: 'schedule' })
    return true
  }

  async function tick(): Promise<void> {
    if (ticking || demoMode.enabled) return
    ticking = true
    try {
      const now = Date.now()
      let runStarted = false
      for (const task of [...tasks.value]) {
        armedAt[task.id] ??= now
        if (!isTaskDue(task, armedAt[task.id], now)) continue
        if (await handleDueTask(task, runStarted)) runStarted = true
      }
    } catch (error) {
      errors.report(error, {
        category: 'unknown',
        code: 'agent-maker/scheduler-failed',
        userMessage: 'The task scheduler failed.',
        surface: 'silent',
      })
    } finally {
      ticking = false
    }
  }

  function startScheduler(): void {
    if (schedulerTimer) clearInterval(schedulerTimer)
    const now = Date.now()
    for (const task of tasks.value) armedAt[task.id] = now
    schedulerTimer = setInterval(() => void tick(), SCHEDULER_TICK_MS)
  }

  async function stopRun(): Promise<void> {
    if (!activeRun.value) return
    stopRequested = true
    if (agentMode.activeSessionId === activeRun.value.sessionId) await agentMode.stop()
  }

  /** Show a run (live or finished) in Agent Mode. */
  async function openRun(sessionId: string): Promise<void> {
    if (!agentMode.sessions[sessionId]) return
    // Switching sessions stops the live turn, so a running run can only be opened itself.
    if (activeRun.value && activeRun.value.sessionId !== sessionId) return
    await agentMode.switchSession(sessionId, { keepPreset: true })
    if (presets.activePresetName !== AGENT_PRESET) {
      await presetSwitching.switchPreset(AGENT_PRESET)
    }
  }

  /** Leave the Agent view for Agent Maker, on the history of the open run's task. */
  async function backToAgentMaker(): Promise<void> {
    const preset = presets.presets.find(
      (p) => p.type === 'chat' && (p as ChatPreset).agentMaker === true,
    )
    if (!preset) return
    focusTaskId.value = agentMode.activeTaskRunId
    await presetSwitching.switchPreset(preset.name)
  }

  return {
    tasks,
    focusTaskId,
    scheduleSkips,
    nextScheduledRun,
    backToAgentMaker,
    hydrated,
    activeRun,
    activeSessionTask,
    canStartRun,
    init,
    findTask,
    saveTask,
    deleteTask,
    taskRuns,
    runStatus,
    startRun,
    stopRun,
    openRun,
  }
})

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    if (schedulerTimer) clearInterval(schedulerTimer)
    schedulerTimer = null
  })
  import.meta.hot.accept(acceptHMRUpdate(useAgentMaker, import.meta.hot))
}
