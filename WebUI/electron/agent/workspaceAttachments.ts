import fs from 'node:fs'
import path from 'node:path'
import { promptImageAttachments } from '@/types/agentIpc'

// ── Workspace attachments ────────────────────────────────────────────────────
//
// What "attach a file" means for an agent, as opposed to a chat: the file is
// copied into the workspace and the agent is told the path. It then reads,
// references or ships the file with the tools it already has — a PNG becomes a
// sprite the game loads, a text file becomes something it can read — and this
// works whatever the model is. A vision model is also shown the images in the
// same turn (`turnAttachments`), on top of the copy.

/** Folder inside the workspace that user-supplied files land in. */
export const ATTACHMENTS_DIR = 'attachments'

/**
 * Reduce a client-supplied filename to a bare, safe basename.
 *
 * The name comes from the renderer, so it is untrusted: anything that could walk
 * out of the folder (separators, `..`, a drive letter) has to go before it is
 * joined onto the workspace path.
 */
function safeBasename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const cleaned = base.replace(/[\0-\x1f<>:"|?*]/g, '').replace(/^\.+/, '')
  return cleaned || 'attachment'
}

/** `sprite.png` → `sprite-2.png`, so a second attachment cannot overwrite the first. */
function uniquePath(dir: string, filename: string): string {
  const extension = path.extname(filename)
  const stem = path.basename(filename, extension)
  let candidate = filename
  for (let n = 2; fs.existsSync(path.join(dir, candidate)); n++) {
    candidate = `${stem}-${n}${extension}`
  }
  return path.join(dir, candidate)
}

/**
 * Save one attachment into the workspace and return its workspace-relative path
 * (POSIX separators, which is how every tool and the preview server address
 * workspace files).
 */
export function importAttachment(
  workspaceDir: string,
  name: string,
  bytes: Uint8Array,
): { path: string } {
  const root = fs.realpathSync(path.resolve(workspaceDir))
  const dir = path.join(root, ATTACHMENTS_DIR)
  fs.mkdirSync(dir, { recursive: true })

  const target = uniquePath(dir, safeBasename(name))
  // Belt and braces: `safeBasename` already removed the ways out of the folder,
  // so a target outside it means that sanitizing has a hole rather than that the
  // caller asked for something reasonable.
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to write an attachment outside the workspace: ${name}`)
  }

  fs.writeFileSync(target, bytes)
  return { path: relative.split(path.sep).join('/') }
}

const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
}

export type AttachedImage = { type: 'image'; data: string; mimeType: string }

/**
 * What a turn's prompt carries besides its text: the images its attachments
 * reference, for a model registered with image input. The copy in the workspace
 * stays the file tools work on; this only lets a vision model see it in the
 * same turn. A path that leaves the attachments folder is skipped.
 */
export function turnAttachments(
  workspaceDir: string,
  prompt: string,
  supportsVision: boolean,
): { images: AttachedImage[] } {
  if (!supportsVision) return { images: [] }
  let dir: string
  try {
    dir = fs.realpathSync(path.join(path.resolve(workspaceDir), ATTACHMENTS_DIR))
  } catch {
    return { images: [] }
  }
  const images: AttachedImage[] = []
  for (const relative of promptImageAttachments(prompt)) {
    try {
      const file = fs.realpathSync(path.resolve(workspaceDir, relative))
      const inside = path.relative(dir, file)
      if (inside.startsWith('..') || path.isAbsolute(inside)) continue
      const mimeType = IMAGE_MIME_TYPES[path.extname(file).toLowerCase()]
      if (!mimeType) continue
      images.push({ type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType })
    } catch {
      // Gone or unreadable: the prompt still names the path.
    }
  }
  return { images }
}
