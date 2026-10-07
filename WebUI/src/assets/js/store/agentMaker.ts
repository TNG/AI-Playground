import { defineStore } from 'pinia'
import { ref } from 'vue'
import { useErrors } from './errors'
import { useAgentMode } from './agentMode'
import { usePresets } from './presets'
import { usePresetSwitching } from './presetSwitching'
import type { AgentTask } from '@/types/agentMakerIpc'
import type { AgentSessionRecord } from './agentModeSessions'
import { AGENT_PRESET } from './agentModeSessions'

/**
 * Agent Maker: the renderer-side store for task definitions and the
 * step-driver loop. Task definitions are kernel-owned files
 * (`agentMaker:bootstrap`/`save`/`delete`); run sessions are normal
 * `AgentSessionRecord`s tagged `origin: 'agentMaker'` that open in Agent
 * Mode verbatim.
 *
 * The step loop is renderer-driven (Q16a): `startRun` mints the session +
 * workspace in main, then the renderer switches to Agent Mode, calls
 * `agentMode.switchSession`, sets the frozen task config, and sends each
 * step as a normal `agentMode.generate(step)` turn. Failure detection
 * (the turn's IpcMutationResult) aborts the loop and marks the run failed.
 */
export const useAgentMaker = defineStore('agentMaker', () => {
  const errors = useErrors()
  const agentMode = useAgentMode()
  const presets = usePresets()
  const presetSwitching = usePresetSwitching()

  const tasks = ref<AgentTask[]>([])
  const hydrated = ref(false)

  async function init(): Promise<void> {
    if (hydrated.value) return
    const result = await window.electronAPI.agentMaker.bootstrap()
    if (result.status === 'ok') {
      tasks.value = result.tasks
    } else if (result.status === 'error') {
      errors.report(new Error(result.error), {
        category: 'unknown',
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

  async function saveTask(task: AgentTask): Promise<void> {
    const result = await window.electronAPI.agentMaker.save(task)
    if (!result.success) {
      errors.report(new Error(result.error), {
        category: 'unknown',
        code: 'agent-maker/save-failed',
        userMessage: `Could not save the task: ${result.error}`,
        surface: 'toast',
      })
      return
    }
    // Re-fetch the task from main so the slug main generated is reflected here.
    const bootstrap = await window.electronAPI.agentMaker.bootstrap()
    if (bootstrap.status === 'ok') {
      const saved = bootstrap.tasks.find((t) => t.id === task.id)
      if (saved) {
        const existing = tasks.value.findIndex((t) => t.id === task.id)
        if (existing >= 0) {
          tasks.value = [
            ...tasks.value.slice(0, existing),
            saved,
            ...tasks.value.slice(existing + 1),
          ]
        } else {
          tasks.value = [...tasks.value, saved]
        }
        return
      }
    }
    // Fallback: use the task as-is (slug may be empty).
    const existing = tasks.value.findIndex((t) => t.id === task.id)
    if (existing >= 0) {
      tasks.value = [...tasks.value.slice(0, existing), task, ...tasks.value.slice(existing + 1)]
    } else {
      tasks.value = [...tasks.value, task]
    }
  }

  async function deleteTask(id: string): Promise<void> {
    // Delete any run sessions first (cascade), then the task.
    const runIds = Object.values(agentMode.sessions)
      .filter((s) => s.taskId === id)
      .map((s) => s.id)
    for (const runId of runIds) {
      if (runId === agentMode.activeSessionId) {
        await agentMode.deleteSession(runId)
      } else {
        await window.electronAPI.agentMode.deleteSession(runId)
        delete agentMode.sessions[runId]
      }
    }
    await window.electronAPI.agentMaker.delete(id)
    tasks.value = tasks.value.filter((t) => t.id !== id)
  }

  /** A task's runs, newest first. */
  function taskRuns(taskId: string): AgentSessionRecord[] {
    return Object.values(agentMode.sessions)
      .filter((s) => s.origin === 'agentMaker' && s.taskId === taskId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /**
   * Start a task run: mint the session + workspace in main, switch to
   * Agent Mode, set the frozen task config, and drive the step loop.
   * After the steps complete, the session stays open for free interaction
   * with the live model.
   */
  async function startRun(taskId: string): Promise<void> {
    const task = findTask(taskId)
    if (!task) {
      errors.report(new Error(`Task not found: ${taskId}`), {
        category: 'validation',
        code: 'agent-maker/task-not-found',
        userMessage: 'Task not found.',
        surface: 'toast',
      })
      return
    }

    // 1. Mint the session + workspace in main.
    const result = await window.electronAPI.agentMaker.startRun(taskId)
    if (!result.success) {
      errors.report(new Error(result.error), {
        category: 'inference',
        code: 'agent-maker/start-failed',
        userMessage: `Could not start the run: ${result.error}`,
        surface: 'toast',
      })
      return
    }
    const { sessionId, workspaceDir } = result

    // 2. Ensure the session record is in the store.
    agentMode.sessions = {
      ...agentMode.sessions,
      [sessionId]: {
        id: sessionId,
        workspaceDir,
        title: task.name,
        messages: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        capabilities: [...task.capabilities],
        presetName: AGENT_PRESET,
        origin: 'agentMaker',
        taskId: task.id,
        taskRunStatus: 'running',
        taskRunStepIndex: 0,
      },
    }

    // 3. Switch to Agent Mode and the new session.
    if (presets.activePresetName !== AGENT_PRESET) {
      await presetSwitching.switchPreset(AGENT_PRESET)
    }
    await agentMode.switchSession(sessionId)

    // 4. Set the frozen task config so the turn engine builds step turns
    //    from it instead of the live textInference store.
    agentMode.setTaskRunConfig(task)

    // 5. Drive the step loop.
    try {
      for (let i = 0; i < task.steps.length; i++) {
        const record = agentMode.sessions[sessionId]
        if (record) {
          agentMode.sessions = {
            ...agentMode.sessions,
            [sessionId]: { ...record, taskRunStepIndex: i },
          }
        }
        await agentMode.generate(task.steps[i])
        // After generate returns, check whether the turn failed. The agent's
        // onError fires on a failed turn, but generate itself does not throw.
        // A failed turn leaves a non-empty error; we detect it by checking
        // the last message for an error part.
        const messages = agentMode.messages as unknown as {
          role: string
          parts: { type: string; errorText?: string }[]
        }[]
        const lastMsg = messages[messages.length - 1]
        const hasError = lastMsg && lastMsg.parts?.some((p) => p.type === 'error' && p.errorText)
        if (hasError) {
          const failRecord = agentMode.sessions[sessionId]
          if (failRecord) {
            agentMode.sessions = {
              ...agentMode.sessions,
              [sessionId]: {
                ...failRecord,
                taskRunStatus: 'failed',
                taskRunError: `Step ${i + 1} failed`,
              },
            }
          }
          agentMode.setTaskRunConfig(null)
          return
        }
      }
      const doneRecord = agentMode.sessions[sessionId]
      if (doneRecord) {
        agentMode.sessions = {
          ...agentMode.sessions,
          [sessionId]: { ...doneRecord, taskRunStatus: 'completed' },
        }
      }
    } finally {
      agentMode.setTaskRunConfig(null)
    }
  }

  /**
   * Open a completed/failed run in Agent Mode for free interaction.
   * After a run's steps complete, the user can continue chatting with
   * the live model (not the task's frozen config).
   */
  async function openRun(sessionId: string): Promise<void> {
    const record = agentMode.sessions[sessionId]
    if (!record) return
    if (presets.activePresetName !== AGENT_PRESET) {
      await presetSwitching.switchPreset(AGENT_PRESET)
    }
    await agentMode.switchSession(sessionId)
    agentMode.setTaskRunConfig(null)
  }

  return {
    tasks,
    hydrated,
    init,
    findTask,
    saveTask,
    deleteTask,
    taskRuns,
    startRun,
    openRun,
  }
})
