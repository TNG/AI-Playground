import fs from 'node:fs'
import path from 'node:path'
import type { WebContents } from 'electron'
import type { AgentMediaFileAction, AgentMediaFileRef } from '@/types/agentMediaDetails'
import type { IpcMutationResult } from '@/types/ipcChannels'

// ── File actions on an agent's generated media ───────────────────────────────
//
// The transcript displays the app-folder copy, but Open, Open in folder, drag-out
// and save act on the agent's working file under `<workspace>/generated/`. The
// workspace is looked up from the session, never taken from the renderer, and a
// workspace file the user has since deleted falls back to the app copy.

export type WorkspaceMediaFileDeps = {
  sessionWorkspaceDir: (sessionId: string) => Promise<string | null>
  mediaUrlPath: (url: string) => string | null
  audioDir: () => string
  open: (filePath: string) => unknown
  reveal: (filePath: string) => unknown
  drag: (sender: WebContents, filePath: string) => unknown
  saveCopy: (sender: WebContents, filePath: string) => unknown
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative)
}

function isFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

/** The workspace file, null when it is gone; throws when the path leaves the workspace. */
async function workspaceFile(
  deps: WorkspaceMediaFileDeps,
  ref: AgentMediaFileRef,
): Promise<string | null> {
  if (!ref.workspacePath) return null
  const workspaceDir = await deps.sessionWorkspaceDir(ref.sessionId)
  if (!workspaceDir) return null
  const root = fs.realpathSync(workspaceDir)
  const fullPath = path.resolve(root, ref.workspacePath)
  if (!isInside(root, fullPath)) {
    throw new Error(`Path escapes the workspace folder: ${ref.workspacePath}`)
  }
  if (!isFile(fullPath)) return null
  if (!isInside(root, fs.realpathSync(fullPath))) {
    throw new Error(`Path escapes the workspace folder: ${ref.workspacePath}`)
  }
  return fullPath
}

function appCopyFile(deps: WorkspaceMediaFileDeps, appCopy: string): string | null {
  const fullPath = appCopy.startsWith('aipg-media://')
    ? deps.mediaUrlPath(appCopy)
    : path.isAbsolute(appCopy) && isInside(path.resolve(deps.audioDir()), path.resolve(appCopy))
      ? path.resolve(appCopy)
      : null
  return fullPath && isFile(fullPath) ? fullPath : null
}

export function workspaceMediaFileActions(deps: WorkspaceMediaFileDeps) {
  return async (
    sender: WebContents,
    ref: AgentMediaFileRef,
    action: AgentMediaFileAction,
  ): Promise<IpcMutationResult> => {
    try {
      const filePath = (await workspaceFile(deps, ref)) ?? appCopyFile(deps, ref.appCopy)
      if (!filePath) return { success: false, error: 'The file no longer exists.' }
      if (action === 'open') await deps.open(filePath)
      else if (action === 'reveal') await deps.reveal(filePath)
      else if (action === 'drag') await deps.drag(sender, filePath)
      else await deps.saveCopy(sender, filePath)
      return { success: true }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  }
}
