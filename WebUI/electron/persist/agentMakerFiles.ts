import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'
import { getAgentMakerDemoDir, getAgentMakerDir } from './userDataPaths'
import {
  assertSafeFileId,
  atomicWriteJson,
  isSafeFileId,
  makeWriteChains,
  readJson,
  type JsonRead,
} from './fsJsonStore'
import { emitStored } from '../kernel/kernelBus'
import {
  AgentMakerIndexFileSchema,
  AgentTaskSchema,
  migrateAgentTaskDoc,
  type AgentMakerBootstrap,
  type AgentMakerIndexFile,
  type AgentTask,
} from '@/types/agentMakerIpc'

/**
 * The kernel's one-writer Agent Maker store: task definitions live as
 * `task.json` under `<root>/agent-maker/<slug>/`, with an `index.json` at the
 * collection root. Run *sessions* are normal `AgentSessionRecord`s tagged with
 * `origin: 'agentMaker'` — they ride `agentSessionFiles.ts` and open in Agent
 * Mode verbatim. Only the run *workspace* (the folder the agent writes into)
 * lives here, minted empty under `<slug>/runs/<run-id>/`.
 *
 * Same correctness contract as agentSessionFiles.ts: atomic writes, schema
 * validation on read, per-key write chains with the index chain nested inside,
 * never the reverse.
 */

const appLogger = appLoggerInstance
const LOG_SCOPE = 'agent-maker'

export type AgentMakerFileDeps = {
  isDemoMode: () => boolean
}

let agentMakerFileDeps: AgentMakerFileDeps | null = null

export function setAgentMakerFileDeps(deps: AgentMakerFileDeps): void {
  agentMakerFileDeps = deps
}

const { serialize, clear: clearChains } = makeWriteChains()

const INDEX_CHAIN = 'index'
const INDEX_FILE = 'index.json'
const TASK_FILE = 'task.json'
const RUNS_DIR = 'runs'

function makerDir(): string {
  return agentMakerFileDeps?.isDemoMode() ? getAgentMakerDemoDir() : getAgentMakerDir()
}

function indexFile(): string {
  return path.join(makerDir(), INDEX_FILE)
}

function taskDir(slug: string): string {
  assertSafeFileId(slug, 'agent maker task slug')
  return path.join(makerDir(), slug)
}

function taskFile(slug: string): string {
  return path.join(taskDir(slug), TASK_FILE)
}

function runsDir(slug: string): string {
  return path.join(taskDir(slug), RUNS_DIR)
}

function runWorkspaceDir(slug: string, runId: string): string {
  assertSafeFileId(runId, 'agent maker run id')
  return path.join(runsDir(slug), runId)
}

function emptyIndex(): AgentMakerIndexFile {
  return { schemaVersion: 1, tasks: [] }
}

async function writeIndex(index: AgentMakerIndexFile): Promise<void> {
  await atomicWriteJson(indexFile(), index)
}

function parseTaskDoc(read: JsonRead): AgentTask | null {
  if (read.status !== 'ok') return null
  const parsed = AgentTaskSchema.safeParse(migrateAgentTaskDoc(read.value))
  if (parsed.success) return parsed.data
  appLogger.warn('agent maker task file failed schema; treated as missing', LOG_SCOPE)
  return null
}

async function rebuildIndexFromTaskFiles(): Promise<AgentMakerIndexFile> {
  let entries: { dir: string; name: string }[] = []
  try {
    entries = (await fs.readdir(makerDir(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ dir: entry.name, name: entry.name }))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return emptyIndex()
  }
  const tasks: AgentMakerIndexFile['tasks'] = []
  for (const { dir: slug } of entries) {
    if (!isSafeFileId(slug)) continue
    const doc = parseTaskDoc(await readJson(taskFile(slug), LOG_SCOPE))
    if (!doc) continue
    tasks.push({ id: doc.id, slug: doc.slug, updatedAt: doc.updatedAt })
  }
  tasks.sort((a, b) => a.updatedAt - b.updatedAt)
  const index: AgentMakerIndexFile = { schemaVersion: 1, tasks }
  await writeIndex(index)
  return index
}

async function readIndex(): Promise<AgentMakerIndexFile | null> {
  const raw = await readJson(indexFile(), LOG_SCOPE)
  if (raw.status === 'missing') {
    try {
      const entries = await fs.readdir(makerDir(), { withFileTypes: true })
      if (entries.filter((e) => e.isDirectory()).length === 0) return null
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
    appLogger.warn('agent maker index missing; rebuilding from task files', LOG_SCOPE)
    return rebuildIndexFromTaskFiles()
  }
  if (raw.status === 'ok') {
    const parsed = AgentMakerIndexFileSchema.safeParse(raw.value)
    if (parsed.success) return parsed.data
  }
  appLogger.warn('agent maker index failed schema; rebuilding from task files', LOG_SCOPE)
  return rebuildIndexFromTaskFiles()
}

async function currentIndex(): Promise<AgentMakerIndexFile> {
  return (await readIndex()) ?? emptyIndex()
}

// ── Slug derivation ──────────────────────────────────────────────────────────

/**
 * Filesystem-safe slug from a task name: lowercase, dash-joined, collision-
 * suffixed with a short id when the folder already exists under a different id.
 */
export function slugifyTaskName(name: string): string {
  const base =
    name
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'task'
  return base
}

async function uniqueSlug(base: string, excludeId?: string): Promise<string> {
  const index = await currentIndex()
  const taken = new Set(index.tasks.filter((t) => t.id !== excludeId).map((t) => t.slug))
  if (!taken.has(base)) return base
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate)) return candidate
  }
  return `${base}-${Date.now().toString(36)}`
}

// ── Public API (IPC handlers) ────────────────────────────────────────────────

export async function bootstrapAgentMaker(): Promise<AgentMakerBootstrap> {
  return serialize(INDEX_CHAIN, async () => {
    const index = await readIndex()
    if (index === null) return { status: 'empty' as const }
    const tasks: AgentTask[] = []
    for (const entry of index.tasks) {
      if (!isSafeFileId(entry.slug)) continue
      const doc = parseTaskDoc(await readJson(taskFile(entry.slug), LOG_SCOPE))
      if (doc) tasks.push(doc)
    }
    return { status: 'ok' as const, tasks }
  })
}

export async function saveAgentTask(task: AgentTask): Promise<void> {
  const targetSlug = task.slug || slugifyTaskName(task.name)
  const finalSlug = await uniqueSlug(targetSlug, task.id)
  assertSafeFileId(finalSlug, 'agent maker task slug')
  const taskWithSlug = { ...task, slug: finalSlug }

  // If this is an edit and the slug changed, move the task folder (runs and all).
  const existing = await currentIndex()
  const existingEntry = existing.tasks.find((t) => t.id === task.id)
  if (existingEntry && existingEntry.slug !== finalSlug) {
    await moveTaskFolder(existingEntry.slug, finalSlug)
  }

  return serialize(finalSlug, async () => {
    await atomicWriteJson(taskFile(finalSlug), taskWithSlug)
    await serialize(INDEX_CHAIN, async () => {
      const index = await currentIndex()
      const entry = { id: task.id, slug: finalSlug, updatedAt: task.updatedAt }
      index.tasks = [...index.tasks.filter((t) => t.id !== task.id && t.slug !== finalSlug), entry]
      await writeIndex(index)
    })
  }).then(() => {
    emitStored('agentMaker', task.id)
  })
}

/**
 * Move a task's folder when its slug changed (rename). The stable link is the
 * task id (stored in run session records), so a rename never orphans runs.
 */
export async function moveTaskFolder(oldSlug: string, newSlug: string): Promise<void> {
  if (oldSlug === newSlug) return
  assertSafeFileId(oldSlug, 'agent maker old slug')
  assertSafeFileId(newSlug, 'agent maker new slug')
  const oldDir = taskDir(oldSlug)
  const newDir = taskDir(newSlug)
  try {
    await fs.rename(oldDir, newDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

/**
 * Mint a fresh empty workspace for a run and return its absolute path. The
 * workspace IS the run folder — the agent writes directly into it.
 */
export async function mintRunWorkspace(taskSlug: string, runId: string): Promise<string> {
  assertSafeFileId(taskSlug, 'agent maker task slug')
  assertSafeFileId(runId, 'agent maker run id')
  const dir = runWorkspaceDir(taskSlug, runId)
  await fs.mkdir(dir, { recursive: true })
  return dir
}

/** Remove one run's workspace folder (retention keeps a task's newest runs). */
export async function deleteRunWorkspace(taskId: string, runId: string): Promise<void> {
  const entry = (await currentIndex()).tasks.find((t) => t.id === taskId)
  if (!entry) return
  await fs.rm(runWorkspaceDir(entry.slug, runId), { recursive: true, force: true })
}

/**
 * Remove a task's folder (task.json and every run workspace under `runs/`) and
 * its index entry. The run session records live in the agent-sessions
 * collection and are deleted by the renderer through `agentMode:deleteSession`,
 * which also tears down their Pi state.
 */
export async function deleteAgentTask(taskId: string): Promise<void> {
  const index = await currentIndex()
  const entry = index.tasks.find((t) => t.id === taskId)
  if (!entry) return
  const slug = entry.slug
  assertSafeFileId(slug, 'agent maker task slug')
  await serialize(slug, async () => {
    await fs.rm(taskDir(slug), { recursive: true, force: true })
    await serialize(INDEX_CHAIN, async () => {
      const idx = await currentIndex()
      idx.tasks = idx.tasks.filter((t) => t.id !== taskId)
      await writeIndex(idx)
    })
  })
  emitStored('agentMaker', taskId)
}

/** §6.1: demo tasks are session-scoped; wipe on exit (and on boot, for a crash tail). */
export async function wipeDemoAgentMaker(): Promise<void> {
  try {
    await fs.rm(getAgentMakerDemoDir(), { recursive: true, force: true })
  } catch (error) {
    appLogger.warn(`demo agent maker wipe failed: ${String(error)}`, LOG_SCOPE)
  }
}

export function resetAgentMakerFilesForTest(): void {
  agentMakerFileDeps = null
  clearChains()
}
