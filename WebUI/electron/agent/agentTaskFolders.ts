import { openDirectory } from '../adapters/osFileActions'
import { readAgentTasks } from '../persist/agentTaskFiles'
import { sameHostPath } from '@/lib/mountedFolders'

/** Opens one of a saved Agent's Mounted Folders in the file manager, and never any other path. */
export async function openAgentTaskFolder(taskId: string, hostPath: string): Promise<void> {
  const task = (await readAgentTasks()).find((entry) => entry.id === taskId)
  const folder = task?.settingsTemplate.mountedFolders?.find((entry) =>
    sameHostPath(entry.hostPath, hostPath),
  )
  if (!folder) throw new Error(`${hostPath} is not a folder of this Agent`)
  await openDirectory(folder.hostPath)
}
