import fs from 'node:fs'
import path from 'node:path'
import { containedIn } from './hostPathContainment.ts'
import { promptImageAttachments } from '@/types/agentIpc'

// ── Workspace attachments ────────────────────────────────────────────────────
//
// What "attach a file" means for an agent, as opposed to a chat: the file is
// copied in and the agent is told its path. A game keeps attachments in its
// folder as `attachments/<file>`, where it ships them. A Session keeps them in its
// internal storage, outside every Workspace; the sandbox mounts that read-only at
// `/attachments`, and the app's own tools resolve the same path (`agentFileRoot`).

/** The folder a game keeps attachments in, and how its prompts name them. */
export const ATTACHMENTS_DIR = 'attachments'

/** Where a Session's attachments appear in the sandbox. */
export const SANDBOX_ATTACHMENTS_DIR = '/attachments'

/** Where attached files are kept (`dir`), and the path prefix a prompt names them by. */
export type AttachmentsFolder = { dir: string; reference: string }

/** The folders a turn's file references resolve against. */
export type AgentFiles = {
  workspaceDir: string
  /** The Workspace's sandbox path, `/mnt/<slug>` in a Session. */
  workspaceMount?: string
  /** A Session's attachments, mounted at `/attachments`. */
  attachmentsDir?: string
}

/**
 * The host folder a model-given reference lives in, and the path below it: `/attachments/…`
 * (or the attachments' real path) is a Session's attachments, a Workspace sandbox path or a
 * relative path is the Workspace. A relative `attachments/…` the Workspace does not have is
 * read as a Session attachment, which is how references from before the move still resolve.
 */
export function agentFileRoot(
  files: AgentFiles,
  reference: string,
): { root: string; relative: string } {
  const ref = reference.replace(/^@/, '').replace(/^"(.*)"$/, '$1')
  const { attachmentsDir } = files
  if (attachmentsDir && ref.startsWith(`${SANDBOX_ATTACHMENTS_DIR}/`)) {
    return { root: attachmentsDir, relative: ref.slice(SANDBOX_ATTACHMENTS_DIR.length + 1) }
  }
  if (attachmentsDir && path.isAbsolute(ref) && containedIn(attachmentsDir, ref)) {
    return { root: attachmentsDir, relative: path.relative(attachmentsDir, ref) }
  }
  const mount = [files.workspaceMount, '/workspace'].find((m) => m && ref.startsWith(`${m}/`))
  const relative = mount ? ref.slice(mount.length + 1) : ref
  const legacy = relative.startsWith(`${ATTACHMENTS_DIR}/`)
  if (attachmentsDir && legacy && !fs.existsSync(path.join(files.workspaceDir, relative))) {
    return { root: attachmentsDir, relative: relative.slice(ATTACHMENTS_DIR.length + 1) }
  }
  return { root: files.workspaceDir, relative }
}

/**
 * A Session's attachments as a turn names them: `/attachments` in the sandbox, their real
 * path under the real shell, which has no such mount.
 */
export function attachmentsSeenBy(
  folder: AttachmentsFolder,
  unsandboxed: boolean,
): AttachmentsFolder {
  if (!unsandboxed || folder.reference !== SANDBOX_ATTACHMENTS_DIR) return folder
  return { dir: folder.dir, reference: path.resolve(folder.dir).split(path.sep).join('/') }
}

/** A prompt's `@/attachments/…` references, as `folder` names them. */
export function withAttachmentReferences(prompt: string, folder: AttachmentsFolder): string {
  if (folder.reference === SANDBOX_ATTACHMENTS_DIR) return prompt
  return prompt.replace(
    /@("?)\/attachments\//g,
    (_match, quote: string) => `@${quote}${folder.reference}/`,
  )
}

/**
 * Resolve a model-provided path to a host file in the Workspace or the attachments,
 * rejecting escapes from that folder and anything that is not an existing file.
 */
export function resolveWorkspaceFile(files: AgentFiles, reference: string): string {
  const { root, relative } = agentFileRoot(files, reference)
  const fullPath = path.resolve(root, relative)
  const inside = path.relative(root, fullPath)
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    throw new Error(`Path escapes the workspace folder: ${reference}`)
  }
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    throw new Error(`File not found in workspace: ${reference}`)
  }
  return fullPath
}

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

/** Save one attachment into `folder` and return how a prompt names it. */
export function importAttachment(
  folder: AttachmentsFolder,
  name: string,
  bytes: Uint8Array,
): { path: string } {
  fs.mkdirSync(folder.dir, { recursive: true })
  const dir = fs.realpathSync(path.resolve(folder.dir))
  const target = uniquePath(dir, safeBasename(name))
  // Belt and braces: `safeBasename` already removed the ways out of the folder,
  // so a target outside it means that sanitizing has a hole rather than that the
  // caller asked for something reasonable.
  const relative = path.relative(dir, target)
  if (relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
    throw new Error(`Refusing to write an attachment outside its folder: ${name}`)
  }

  fs.writeFileSync(target, bytes)
  return { path: `${folder.reference}/${relative}` }
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

/** The images a turn's attachments reference, for a vision model; paths outside are skipped. */
export function turnAttachments(
  files: AgentFiles,
  prompt: string,
  supportsVision: boolean,
): { images: AttachedImage[] } {
  if (!supportsVision) return { images: [] }
  let dir: string
  try {
    dir = fs.realpathSync(files.attachmentsDir ?? path.join(files.workspaceDir, ATTACHMENTS_DIR))
  } catch {
    return { images: [] }
  }
  const images: AttachedImage[] = []
  for (const reference of promptImageAttachments(prompt)) {
    try {
      const { root, relative } = agentFileRoot(files, reference)
      const file = fs.realpathSync(path.resolve(root, relative))
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
