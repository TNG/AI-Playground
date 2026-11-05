import fs from 'node:fs/promises'
import { appLoggerInstance } from '../observability/logger'
import { getAgentTasksDemoFile, getAgentTasksFile } from './userDataPaths.ts'
import { AgentTaskSchema, AgentTasksFileSchema, type AgentTask } from '@/types/agentTaskIpc'
import type { ShutdownCause } from '../kernel/shutdown'
import { atomicWriteJson, makeWriteChains, readJson } from './fsJsonStore'

/**
 * The kernel's one-writer Agents store: `AI-Playground/agent-tasks.json`, every saved
 * Agent in one file. Unlike the workspace pointers, an unreadable file is never
 * replaced by a write — one upsert would otherwise erase every other Task.
 */

const appLogger = appLoggerInstance

const LOG_SCOPE = 'agent-tasks'

export type AgentTaskFilesDeps = {
  isDemoMode: () => boolean
}

let agentTaskFilesDeps: AgentTaskFilesDeps | null = null

export function setAgentTaskFilesDeps(deps: AgentTaskFilesDeps): void {
  agentTaskFilesDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

const FILE_CHAIN = 'file'

// Set once a Quit has settled the Task Runs: the window, still alive during teardown,
// must not write a run back in flight or call the turn it saw aborted a failure.
let runsSealedByQuit = false

function tasksFile(): string {
  return agentTaskFilesDeps?.isDemoMode() ? getAgentTasksDemoFile() : getAgentTasksFile()
}

/** Every saved Task; an absent file is none, an unreadable one throws. */
export async function readAgentTasks(): Promise<AgentTask[]> {
  const read = await readJson(tasksFile(), LOG_SCOPE)
  if (read.status === 'missing') return []
  if (read.status === 'ok') {
    const parsed = AgentTasksFileSchema.safeParse(read.value)
    if (parsed.success) return parsed.data.tasks
  }
  appLogger.warn('agent tasks file unreadable; not treated as absent', LOG_SCOPE)
  throw new Error('agent tasks file unreadable')
}

async function writeTasks(tasks: AgentTask[]): Promise<void> {
  await atomicWriteJson(tasksFile(), { schemaVersion: 1, tasks })
}

/** After a Quit, a saved Task keeps the run state on disk; everything else is the window's. */
function withoutRunChanges(task: AgentTask, stored: AgentTask | undefined): AgentTask {
  const { activeRuns: _activeRuns, lastOutcome: _lastOutcome, ...rest } = task
  return {
    ...rest,
    ...(stored?.activeRuns ? { activeRuns: stored.activeRuns } : {}),
    ...(stored?.lastOutcome ? { lastOutcome: stored.lastOutcome } : {}),
  }
}

/** Insert a Task, or replace the one with the same id where it stands. */
export async function saveAgentTask(payload: unknown): Promise<void> {
  const parsed = AgentTaskSchema.safeParse(payload)
  if (!parsed.success) throw new Error(`invalid task: ${parsed.error.message}`)
  const task = parsed.data
  return serialize(FILE_CHAIN, async () => {
    const tasks = await readAgentTasks()
    const index = tasks.findIndex((entry) => entry.id === task.id)
    const next = runsSealedByQuit ? withoutRunChanges(task, tasks[index]) : task
    if (index >= 0) tasks[index] = next
    else tasks.push(next)
    await writeTasks(tasks)
  })
}

export async function deleteAgentTask(id: unknown): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) throw new Error('task id must be a string')
  return serialize(FILE_CHAIN, async () => {
    const tasks = await readAgentTasks()
    const remaining = tasks.filter((entry) => entry.id !== id)
    if (remaining.length === tasks.length) return
    await writeTasks(remaining)
  })
}

/**
 * A user's Quit ends every Task Run still marked in flight, so each is recorded as
 * stopped. Any other cause leaves the marker for the next launch to call failed / app-closed.
 */
export async function settleTaskRunsOnQuit(cause: ShutdownCause): Promise<void> {
  if (cause !== 'quit') return
  return serialize(FILE_CHAIN, async () => {
    const tasks = await readAgentTasks()
    const at = Date.now()
    let settled = 0
    const next = tasks.map((task): AgentTask => {
      const activeRun = task.activeRuns?.at(-1)
      if (!activeRun) return task
      settled++
      const { activeRuns: _runs, ...rest } = task
      return {
        ...rest,
        lastOutcome: {
          kind: 'stopped',
          at,
          sessionId: activeRun.sessionId,
          stepIndex: activeRun.stepIndex,
          stepCount: activeRun.stepCount,
        },
      }
    })
    if (settled > 0) await writeTasks(next)
    runsSealedByQuit = true
  })
}

/** A deleted Session keeps every Agent; its Schedules go with it. */
export async function forgetSessionInAgentTasks(sessionRef: string): Promise<void> {
  return serialize(FILE_CHAIN, async () => {
    const tasks = await readAgentTasks()
    const touches = (entry: AgentTask) =>
      entry.sessionRef === sessionRef ||
      (entry.schedules ?? []).some((schedule) => schedule.sessionRef === sessionRef)
    if (!tasks.some(touches)) return
    await writeTasks(
      tasks.map((entry) => (touches(entry) ? withoutSession(entry, sessionRef) : entry)),
    )
  })
}

function withoutSession(task: AgentTask, sessionRef: string): AgentTask {
  const { sessionRef: madeIn, schedules, ...rest } = task
  const kept = (schedules ?? []).filter((schedule) => schedule.sessionRef !== sessionRef)
  return {
    ...rest,
    ...(madeIn !== undefined && madeIn !== sessionRef ? { sessionRef: madeIn } : {}),
    ...(kept.length > 0 ? { schedules: kept } : {}),
  }
}

/** §6.1: demo Tasks are session-scoped; wipe on exit (and on boot, for a crash tail). */
export async function wipeDemoAgentTasks(): Promise<void> {
  try {
    await fs.rm(getAgentTasksDemoFile(), { force: true })
  } catch (error) {
    appLogger.warn(`demo agent tasks wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetAgentTaskFilesForTest(): void {
  agentTaskFilesDeps = null
  runsSealedByQuit = false
  clearChains()
}
