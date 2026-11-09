import fs from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import { isSafeFileId } from './fsJsonStore'
import { getAgentTrialsDir } from './userDataPaths.ts'
import { TrialRunRecordSchema } from '@/types/agentTaskIpc'

/**
 * Each Agent's Trial Run scratch folder, `agent-trials/<agentId>/`: the run's workspace
 * (`files/`) and `trial.json`, the record of its Harness Session and progress.
 */

const RECORD = 'trial.json'

const TrialFolderRecordSchema = z.object({
  harnessSessionId: z.string(),
  run: TrialRunRecordSchema.optional(),
})
export type TrialFolderRecord = z.infer<typeof TrialFolderRecordSchema>

const isTrialFolderName = (name: string) => isSafeFileId(name) && !name.startsWith('.')

function folderOf(agentId: string): string {
  if (!isTrialFolderName(agentId)) throw new Error(`invalid agent id: ${agentId}`)
  return path.join(getAgentTrialsDir(), agentId)
}

export async function readTrialFolderRecord(agentId: string): Promise<TrialFolderRecord | null> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(folderOf(agentId), RECORD), 'utf8'))
    return TrialFolderRecordSchema.parse(raw)
  } catch {
    return null
  }
}

export async function writeTrialFolderRecord(
  agentId: string,
  record: TrialFolderRecord,
): Promise<void> {
  // Not atomicWriteJson: it would recreate a folder removed meanwhile.
  await fs.writeFile(path.join(folderOf(agentId), RECORD), JSON.stringify(record))
}

/** A new folder for the Agent's Trial Run; returns its workspace's real path. */
export async function createTrialFolder(
  agentId: string,
  harnessSessionId: string,
): Promise<string> {
  const folder = folderOf(agentId)
  const workspaceDir = path.join(folder, 'files')
  await fs.mkdir(workspaceDir, { recursive: true })
  await fs.writeFile(path.join(folder, RECORD), JSON.stringify({ harnessSessionId }))
  return fs.realpath(workspaceDir)
}

export async function removeTrialFolder(agentId: string): Promise<void> {
  await fs.rm(folderOf(agentId), { recursive: true, force: true })
}

/** The Agents that have a Trial Run folder. */
export async function trialFolderAgentIds(): Promise<string[]> {
  try {
    return (await fs.readdir(getAgentTrialsDir())).filter(isTrialFolderName)
  } catch {
    return []
  }
}

export async function removeTrialFoldersRoot(): Promise<void> {
  await fs.rm(getAgentTrialsDir(), { recursive: true, force: true })
}
