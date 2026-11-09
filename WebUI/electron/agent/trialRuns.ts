import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { appLoggerInstance } from '../observability/logger'
import { assertSafeFileId } from '../persist/fsJsonStore'
import { getAgentTrialsDir } from '../persist/userDataPaths.ts'
import { mintHarnessSessionId } from '../session/sessionHarness'
import type { HarnessSessionRef } from '@/types/sessionIpc'

/**
 * Trial Runs belong to no Session: each Agent has one scratch folder,
 * `agent-trials/<agentId>/`, holding the run's workspace (`files/`) and a record
 * of its Harness Session, so the next Trial Run, a delete or a restart can throw
 * both away.
 */

const LOG_SCOPE = 'trial-runs'
const RECORD = 'trial.json'

const TrialRecordSchema = z.object({ harnessSessionId: z.string() })

export type TrialRunDeps = {
  /** Remove a Harness Session's record and Pi files. */
  deleteHarnessSession: (harnessSessionId: string) => Promise<void>
}

let deps: TrialRunDeps | null = null

export function setTrialRunDeps(next: TrialRunDeps): void {
  deps = next
}

function folderOf(agentId: string): string {
  assertSafeFileId(agentId, 'agent')
  if (agentId.startsWith('.')) throw new Error(`invalid agent id: ${agentId}`)
  return path.join(getAgentTrialsDir(), agentId)
}

async function harnessOf(folder: string): Promise<string | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(folder, RECORD), 'utf8'))
    return TrialRecordSchema.parse(raw).harnessSessionId
  } catch {
    return null
  }
}

async function removeFolder(folder: string): Promise<void> {
  const harnessSessionId = await harnessOf(folder)
  if (harnessSessionId) {
    try {
      await deps?.deleteHarnessSession(harnessSessionId)
    } catch (error) {
      appLoggerInstance.warn(
        `could not delete Trial Run harness ${harnessSessionId}: ${String(error)}`,
        LOG_SCOPE,
      )
    }
  }
  await fs.rm(folder, { recursive: true, force: true })
}

/** A fresh Harness Session for the Agent's next Trial Run; the previous one is thrown away. */
export async function trialRunHarnessFor(agentId: string): Promise<HarnessSessionRef> {
  const folder = folderOf(agentId)
  await removeFolder(folder)
  const workspaceDir = path.join(folder, 'files')
  await fs.mkdir(workspaceDir, { recursive: true })
  const harnessSessionId = mintHarnessSessionId()
  await fs.writeFile(path.join(folder, RECORD), JSON.stringify({ harnessSessionId }))
  return { harnessSessionId, workspaceDir: await fs.realpath(workspaceDir) }
}

/** Throw the Agent's Trial Run away, with its folder and Harness Session. */
export async function discardTrialRun(agentId: string): Promise<void> {
  await removeFolder(folderOf(agentId))
}

/** At start and quit: no Trial Run outlives the app. */
export async function wipeTrialRuns(): Promise<void> {
  const root = getAgentTrialsDir()
  let names: string[]
  try {
    names = await fs.readdir(root)
  } catch {
    return
  }
  await Promise.all(names.map((name) => removeFolder(path.join(root, name))))
  await fs.rm(root, { recursive: true, force: true })
}
