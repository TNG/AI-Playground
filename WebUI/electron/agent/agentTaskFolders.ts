import { openDirectory } from '../adapters/osFileActions'
import { readAgentTasks } from '../persist/agentTaskFiles'
import { sameHostPath } from '@/lib/mountedFolders'

/** Opens one of the folders a saved Agent overrides with in the file manager, never any other path. */
export async function openAgentTaskFolder(taskId: string, hostPath: string): Promise<void> {
  const task = (await readAgentTasks()).find((entry) => entry.id === taskId)
  const overrides = task?.settingsTemplate.folderOverrides
  const folder = [
    ...(overrides?.workspace ? [overrides.workspace] : []),
    ...(overrides?.folders ?? []),
  ].find((entry) => sameHostPath(entry.hostPath, hostPath))
  if (!folder) throw new Error(`${hostPath} is not a folder of this Agent`)
  await openDirectory(folder.hostPath)
}
