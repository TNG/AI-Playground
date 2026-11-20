import { shell } from 'electron'

/** Moves a file or folder to the OS Trash (Recycle Bin on Windows). */
export function moveToTrash(target: string): Promise<void> {
  return shell.trashItem(target)
}
