import fs from 'node:fs/promises'
import { appLoggerInstance } from '../observability/logger'
import {
  getAgentDraftsDemoFile,
  getAgentDraftsFile,
  getAgentTasksDemoFile,
  getAgentTasksFile,
} from './userDataPaths.ts'
import {
  AgentDraftSchema,
  AgentDraftsFileSchema,
  AGENT_LIBRARY_SCHEMA_VERSION,
  AGENT_TASKS_SCHEMA_VERSION,
  AgentTaskSchema,
  AgentTasksFileSchema,
  type AgentDraft,
  type AgentTask,
} from '@/types/agentTaskIpc'
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

async function writeTasks(
  tasks: AgentTask[],
  schemaVersion: number = AGENT_TASKS_SCHEMA_VERSION,
): Promise<void> {
  await atomicWriteJson(tasksFile(), { schemaVersion, tasks })
}

/** The Agents file's schema version; null when it is absent or unreadable. */
async function tasksFileVersion(): Promise<number | null> {
  const read = await readJson(tasksFile(), LOG_SCOPE)
  if (read.status !== 'ok') return null
  const parsed = AgentTasksFileSchema.safeParse(read.value)
  return parsed.success ? parsed.data.schemaVersion : null
}

/** Whether the Agents file was written since the Agent Library migration; absent is not. */
export async function agentLibraryMigrated(): Promise<boolean> {
  return ((await tasksFileVersion()) ?? 0) >= AGENT_LIBRARY_SCHEMA_VERSION
}

/** Rewrites the Agents file at version 2, so the Agent Library migration does not run again. */
export async function markAgentLibraryMigrated(): Promise<void> {
  return serialize(FILE_CHAIN, async () =>
    writeTasks(await readAgentTasks(), AGENT_LIBRARY_SCHEMA_VERSION),
  )
}

/** Whether the Agents file was written since Agent Maker merged into Assistant; absent is not. */
export async function agentMakerMerged(): Promise<boolean> {
  return (await tasksFileVersion()) === AGENT_TASKS_SCHEMA_VERSION
}

type SettingsTemplate = AgentTask['settingsTemplate']

/** Rewrites every Draft's and Agent's Settings Template, then the Agents file's version. */
export async function markAgentMakerMerged(
  update: (template: SettingsTemplate) => SettingsTemplate,
): Promise<void> {
  return serialize(FILE_CHAIN, async () => {
    const drafts = await readAgentDrafts()
    if (drafts.length > 0) {
      await writeDrafts(
        drafts.map((draft) => ({ ...draft, settingsTemplate: update(draft.settingsTemplate) })),
      )
    }
    const tasks = await readAgentTasks()
    await writeTasks(
      tasks.map((task) => ({ ...task, settingsTemplate: update(task.settingsTemplate) })),
    )
  })
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

/** Deletes the Agent and its Draft; an Agent that was only ever a Draft is deleted too. */
export async function deleteAgentTask(id: unknown): Promise<void> {
  if (typeof id !== 'string' || id.length === 0) throw new Error('task id must be a string')
  return serialize(FILE_CHAIN, async () => {
    const tasks = await readAgentTasks()
    const remaining = tasks.filter((entry) => entry.id !== id)
    if (remaining.length !== tasks.length) await writeTasks(remaining)
    await removeDraft(id)
  })
}

function draftsFile(): string {
  return agentTaskFilesDeps?.isDemoMode() ? getAgentDraftsDemoFile() : getAgentDraftsFile()
}

/** Every Agent's Draft; an absent file is none, an unreadable one throws. */
export async function readAgentDrafts(): Promise<AgentDraft[]> {
  const read = await readJson(draftsFile(), LOG_SCOPE)
  if (read.status === 'missing') return []
  if (read.status === 'ok') {
    const parsed = AgentDraftsFileSchema.safeParse(read.value)
    if (parsed.success) return parsed.data.drafts
  }
  appLogger.warn('agent drafts file unreadable; not treated as absent', LOG_SCOPE)
  throw new Error('agent drafts file unreadable')
}

async function writeDrafts(drafts: AgentDraft[]): Promise<void> {
  await atomicWriteJson(draftsFile(), { schemaVersion: 1, drafts })
}

/** Insert an Agent's Draft, or replace the one it has. */
export async function saveAgentDraft(payload: unknown): Promise<void> {
  const parsed = AgentDraftSchema.safeParse(payload)
  if (!parsed.success) throw new Error(`invalid draft: ${parsed.error.message}`)
  const draft = parsed.data
  return serialize(FILE_CHAIN, async () => {
    const drafts = await readAgentDrafts()
    const index = drafts.findIndex((entry) => entry.agentId === draft.agentId)
    if (index >= 0) drafts[index] = draft
    else drafts.push(draft)
    await writeDrafts(drafts)
  })
}

export async function deleteAgentDraft(agentId: unknown): Promise<void> {
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new Error('agent id must be a string')
  }
  return serialize(FILE_CHAIN, () => removeDraft(agentId))
}

async function removeDraft(agentId: string): Promise<void> {
  const drafts = await readAgentDrafts()
  const remaining = drafts.filter((entry) => entry.agentId !== agentId)
  if (remaining.length !== drafts.length) await writeDrafts(remaining)
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
    await fs.rm(getAgentDraftsDemoFile(), { force: true })
  } catch (error) {
    appLogger.warn(`demo agent tasks wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetAgentTaskFilesForTest(): void {
  agentTaskFilesDeps = null
  runsSealedByQuit = false
  clearChains()
}
