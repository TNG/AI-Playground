import { appLoggerInstance } from '../observability/logger'
import { makeWriteChains } from '../persist/fsJsonStore'
import {
  createTrialFolder,
  readTrialFolderRecord,
  removeTrialFolder,
  removeTrialFoldersRoot,
  trialFolderAgentIds,
  writeTrialFolderRecord,
} from '../persist/trialRunFiles'
import { mintHarnessSessionId } from '../session/sessionHarness'
import { TrialRunRecordSchema, type TrialRunRecord } from '@/types/agentTaskIpc'
import type { HarnessSessionRef } from '@/types/sessionIpc'

/**
 * Trial Runs belong to no Session: each Agent has one scratch folder holding the run's
 * workspace and a record of its Harness Session and progress, so the next Trial Run, a
 * delete or a restart can throw both away, and a reloaded window can pick the run up.
 */

const LOG_SCOPE = 'trial-runs'

export type TrialRunDeps = {
  /** Remove a Harness Session's record and Pi files. */
  deleteHarnessSession: (harnessSessionId: string) => Promise<void>
}

let deps: TrialRunDeps | null = null
const chains = makeWriteChains()

export function setTrialRunDeps(next: TrialRunDeps): void {
  deps = next
}

async function removeTrial(agentId: string): Promise<void> {
  const harnessSessionId = (await readTrialFolderRecord(agentId))?.harnessSessionId
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
  await removeTrialFolder(agentId)
}

/** A fresh Harness Session for the Agent's next Trial Run; the previous one is thrown away. */
export async function trialRunHarnessFor(agentId: string): Promise<HarnessSessionRef> {
  return chains.serialize(agentId, async () => {
    await removeTrial(agentId)
    const harnessSessionId = mintHarnessSessionId()
    const workspaceDir = await createTrialFolder(agentId, harnessSessionId)
    return { harnessSessionId, workspaceDir }
  })
}

/** Keep where the Trial Run is, unless it was thrown away or a newer one replaced it. */
export async function saveTrialRun(run: TrialRunRecord): Promise<void> {
  const parsed = TrialRunRecordSchema.parse(run)
  await chains.serialize(parsed.agentId, async () => {
    const record = await readTrialFolderRecord(parsed.agentId)
    if (!record || record.harnessSessionId !== parsed.harnessSessionId) return
    await writeTrialFolderRecord(parsed.agentId, { ...record, run: parsed })
  })
}

/** Every Trial Run whose progress was kept, in flight or ended. */
export async function readTrialRuns(): Promise<TrialRunRecord[]> {
  const records = await Promise.all((await trialFolderAgentIds()).map(readTrialFolderRecord))
  return records.flatMap((record) => (record?.run ? [record.run] : []))
}

/** Throw the Agent's Trial Run away, with its folder and Harness Session. */
export async function discardTrialRun(agentId: string): Promise<void> {
  await chains.serialize(agentId, () => removeTrial(agentId))
}

/** At start and quit: no Trial Run outlives the app. */
export async function wipeTrialRuns(): Promise<void> {
  await Promise.all((await trialFolderAgentIds()).map(removeTrial))
  await removeTrialFoldersRoot()
}
