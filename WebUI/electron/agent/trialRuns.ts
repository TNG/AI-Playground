import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { appLoggerInstance } from '../observability/logger'
import { assertSafeFileId, makeWriteChains } from '../persist/fsJsonStore'
import { getAgentTrialsDir } from '../persist/userDataPaths.ts'
import { mintHarnessSessionId } from '../session/sessionHarness'
import { TrialRunRecordSchema, type TrialRunRecord } from '@/types/agentTaskIpc'
import type { HarnessSessionRef } from '@/types/sessionIpc'

/**
 * Trial Runs belong to no Session: each Agent has one scratch folder,
 * `agent-trials/<agentId>/`, holding the run's workspace (`files/`) and a record
 * of its Harness Session and progress, so the next Trial Run, a delete or a
 * restart can throw both away, and a reloaded window can pick the run up.
 */

const LOG_SCOPE = 'trial-runs'
const RECORD = 'trial.json'

const TrialRecordSchema = z.object({
  harnessSessionId: z.string(),
  run: TrialRunRecordSchema.optional(),
})
type TrialRecord = z.infer<typeof TrialRecordSchema>

export type TrialRunDeps = {
  /** Remove a Harness Session's record and Pi files. */
  deleteHarnessSession: (harnessSessionId: string) => Promise<void>
}

let deps: TrialRunDeps | null = null
const chains = makeWriteChains()

export function setTrialRunDeps(next: TrialRunDeps): void {
  deps = next
}

function folderOf(agentId: string): string {
  assertSafeFileId(agentId, 'agent')
  if (agentId.startsWith('.')) throw new Error(`invalid agent id: ${agentId}`)
  return path.join(getAgentTrialsDir(), agentId)
}

async function recordOf(folder: string): Promise<TrialRecord | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(folder, RECORD), 'utf8'))
    return TrialRecordSchema.parse(raw)
  } catch {
    return null
  }
}

async function removeFolder(folder: string): Promise<void> {
  const harnessSessionId = (await recordOf(folder))?.harnessSessionId
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
  return chains.serialize(agentId, async () => {
    await removeFolder(folder)
    const workspaceDir = path.join(folder, 'files')
    await fs.mkdir(workspaceDir, { recursive: true })
    const harnessSessionId = mintHarnessSessionId()
    await fs.writeFile(path.join(folder, RECORD), JSON.stringify({ harnessSessionId }))
    return { harnessSessionId, workspaceDir: await fs.realpath(workspaceDir) }
  })
}

/** Keep where the Trial Run is, unless it was thrown away or a newer one replaced it. */
export async function saveTrialRun(run: TrialRunRecord): Promise<void> {
  const parsed = TrialRunRecordSchema.parse(run)
  const folder = folderOf(parsed.agentId)
  await chains.serialize(parsed.agentId, async () => {
    const record = await recordOf(folder)
    if (record?.harnessSessionId !== parsed.harnessSessionId) return
    // Not atomicWriteJson: it would recreate a folder removed meanwhile.
    await fs.writeFile(path.join(folder, RECORD), JSON.stringify({ ...record, run: parsed }))
  })
}

/** Every Trial Run whose progress was kept, in flight or ended. */
export async function readTrialRuns(): Promise<TrialRunRecord[]> {
  let names: string[]
  try {
    names = await fs.readdir(getAgentTrialsDir())
  } catch {
    return []
  }
  const records = await Promise.all(
    names.map((name) => recordOf(path.join(getAgentTrialsDir(), name))),
  )
  return records.flatMap((record) => (record?.run ? [record.run] : []))
}

/** Throw the Agent's Trial Run away, with its folder and Harness Session. */
export async function discardTrialRun(agentId: string): Promise<void> {
  const folder = folderOf(agentId)
  await chains.serialize(agentId, () => removeFolder(folder))
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
