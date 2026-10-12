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
import { AGENT_PRESET, type AgentSessionRecord } from './agentModeSessions'
import { buildTaskTurnConfig } from './agentModeTurn'
import { requestDownload } from '@/assets/js/permissions/permissions'
import { isCancellation } from '@/assets/js/errors/appError'
import {
  resolveTaskEmbedding,
  resolveTaskModel,
  type TaskModelEnvironment,
} from '@/lib/agentTaskModel'
import type { AgentTask } from '@/types/agentMakerIpc'

export type AgentRunStatus = 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted'

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

  const tasks = ref<AgentTask[]>([])
  const hydrated = ref(false)
  const activeRun = ref<ActiveAgentRun | null>(null)
  /** Task whose run history the Agent Maker view opens on (set by "Back to Agent Maker"). */
  const focusTaskId = ref<string | null>(null)
  let stopRequested = false

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
    const result = await window.electronAPI.agentMaker.save(task)
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
    return true
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

  const canStartRun = computed(() => !activeRun.value && !agentMode.processing)

  function reportRunFailure(error: unknown, userMessage: string): void {
    errors.report(error, {
      category: 'inference',
      code: 'agent-maker/start-failed',
      userMessage,
      surface: 'toast',
    })
  }

  async function ensureModelDownloaded(task: AgentTask): Promise<void> {
    if (task.model.backend === 'cloud') return
    const openVINO = task.model.backend === 'openVINO'
    const checked = await models.checkModelAlreadyLoaded([
      {
        repo_id: task.model.model,
        type: openVINO ? 'openvinoLLM' : 'ggufLLM',
        backend: openVINO ? 'openvino' : 'llama_cpp',
      },
    ])
    const missing = checked.filter((m) => !m.already_loaded)
    if (missing.length > 0) await requestDownload(missing)
  }

  /**
   * Start a run and drive its steps as consecutive turns of one session. The
   * run executes in the background of the Agent Maker view; `openRun` shows it
   * in Agent Mode. Afterwards the session stays open, still on the task's model.
   */
  async function startRun(taskId: string): Promise<void> {
    const task = findTask(taskId)
    if (!task || !canStartRun.value) return

    try {
      resolveTaskModel(task.model, await taskEnvironment(task))
      await ensureModelDownloaded(task)
    } catch (error) {
      if (isCancellation(error)) return
      reportRunFailure(error, `Could not start the run: ${(error as Error).message ?? error}`)
      return
    }

    const result = await window.electronAPI.agentMaker.startRun(taskId)
    if (!result.success) {
      reportRunFailure(new Error(result.error), `Could not start the run: ${result.error}`)
      return
    }
    const { sessionId, workspaceDir } = result
    const now = Date.now()
    agentMode.adoptSessionRecord({
      id: sessionId,
      workspaceDir,
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
    })

    stopRequested = false
    activeRun.value = { taskId, sessionId, stepIndex: 0, stepCount: task.steps.length }
    try {
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
    }
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
  import.meta.hot.accept(acceptHMRUpdate(useAgentMaker, import.meta.hot))
}
