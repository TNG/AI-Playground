import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { BrowserWindow, dialog, nativeImage, shell, type WebContents } from 'electron'

/** Open a file with the OS default application. */
export function openFileWithSystem(filePath: string): Promise<string> {
  return shell.openPath(filePath)
}

/** Reveal a file in the OS file manager. */
export function revealFileInFolder(filePath: string): void {
  if (process.platform === 'win32') {
    // `execFile`, not `exec`: the path is passed as an argument rather than
    // spliced into a shell command line, so a media path containing a
    // quote or an `&` opens the folder instead of running as a command.
    execFile('explorer.exe', ['/select,', filePath])
  } else {
    shell.showItemInFolder(filePath)
  }
}

/** Start an OS drag of a file, with its thumbnail or `fallbackIcon` as the drag image. */
export async function startFileDrag(
  sender: WebContents,
  filePath: string,
  fallbackIcon: string,
): Promise<void> {
  const size = { height: 128, width: 128 }
  const icon = await nativeImage
    .createThumbnailFromPath(filePath, size)
    .catch(() => nativeImage.createThumbnailFromPath(fallbackIcon, size))
  sender.startDrag({ file: filePath, icon })
}

/** Copy a file to where the user picks in a save dialog; cancelling is not a failure. */
export async function saveFileCopy(sender: WebContents, filePath: string): Promise<void> {
  const win = BrowserWindow.fromWebContents(sender)
  const options = { defaultPath: path.basename(filePath) }
  const result = win
    ? await dialog.showSaveDialog(win, options)
    : await dialog.showSaveDialog(options)
  if (result.canceled || !result.filePath) return
  await fs.promises.copyFile(filePath, result.filePath)
}
