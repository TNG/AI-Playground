import fs from 'node:fs'
import path from 'node:path'
import fsp from 'node:fs/promises'
import { nativeImage } from 'electron'
import type { IFileSystem } from 'just-bash'
import { Type } from 'typebox'
import type {
  BashOperations,
  EditOperations,
  FindOperations,
  LsOperations,
  ReadOperations,
  ToolDefinition,
  WriteOperations,
} from '@earendil-works/pi-coding-agent'
import { appLoggerInstance } from '../observability/logger.ts'
import { loadJustBash, loadPi, type JustBashModule, type PiModule } from './piRuntime.ts'
import type { AgentSkill } from './piCustomTools.ts'
import {
  isWritable,
  mountedFolderSandboxPath,
  type ResolvedMountedFolder,
} from '@/lib/mountedFolders'
import { containedIn, realDestination } from './hostPathContainment.ts'
import { SANDBOX_ATTACHMENTS_DIR } from './workspaceAttachments.ts'
import { recordWorkspaceWrite } from './workspaceJournal.ts'

// ── Agent Mode file/shell access ─────────────────────────────────────────────
//
// Pi's built-in tools (read, write, edit, bash, grep, find, ls) each accept
// pluggable `*Operations`, so the host decides what "the filesystem" and "the
// shell" mean without Pi knowing. Two modes:
//
//  - sandboxed (default): every operation is served by a just-bash sandbox
//    whose virtual filesystem mounts ONLY the workspace folder (real files,
//    read-write) at its mount point, plus the user's Mounted Folders at
//    `/mnt/<name>`. The emulated shell has no
//    script interpreters (python3, js-exec) and no host process ever spawns,
//    so nothing outside the workspace is reachable — by construction, not by
//    path checking.
//
//  - host shell (opt-in per workspace, see the agentMode store): Pi's own local
//    operations run against the real filesystem and a real shell, so `node`,
//    `npm` and `python` work. Containment is then enforced here: file writes
//    and edits are rejected outside the workspace, and the shell is pinned to
//    the workspace as its working directory.
//
// Either way the model sees the same tools with the same schemas, and the
// workspace is the same real folder the user picked.

const logger = appLoggerInstance
const LOG_SOURCE = 'piToolOperations'

/** Mount point (and Pi's cwd) of a game's workspace in the sandbox; a Session's is `/mnt/<slug>`. */
export const SANDBOX_WORKDIR = '/workspace'

/**
 * Where the app's skills appear inside the sandbox. Pi advertises a skill by
 * telling the model to `read` its file, so the file has to exist in whatever
 * filesystem the read tool is backed by — the sandbox gets an in-memory copy
 * here rather than a mount of the host's userData directory.
 */
export const SANDBOX_SKILLS_DIR = '/skills'

/**
 * Sandbox HOME, deliberately outside the workspace mount so Pi's own
 * scaffolding stays in the in-memory filesystem instead of the user's folder.
 */
const SANDBOX_HOME = '/home/agent'

export type AgentToolAccess = {
  /** Pi tool definitions for the built-in file/shell tools. */
  definitions: ToolDefinition[]
  /** Pi's working directory: the sandbox mount point, or the real folder. */
  cwd: string
  /** Directory the model can read the app's skills from, in this mode. */
  skillsRoot: string
  /** Release sandbox resources. No-op in host-shell mode. */
  dispose: () => Promise<void>
}

export type AgentToolAccessOptions = {
  workspaceDir: string
  unsandboxed: boolean
  /** The Harness Session the tools belong to; present, its writes are journaled. */
  sessionId?: string
  /** Host directory holding the written SKILL.md files. */
  skillsDir: string
  skills: AgentSkill[]
  /**
   * Builtin tools to keep, when a capability owns the session and says which
   * ones its workflow uses. The whole toolbox when absent.
   */
  baseTools?: string[]
  /**
   * Workspace-relative paths the file tools may write, for a capability whose
   * output is a fixed set of files. Any path when absent.
   */
  writableFiles?: string[]
  /** Folders beside the workspace, each realpathed, seen at `/mnt/<name>` in the sandbox. */
  mountedFolders?: ResolvedMountedFolder[]
  /** Where the sandbox mounts the workspace, its working directory; SANDBOX_WORKDIR when absent. */
  workspaceMount?: string
  /** A Session's attachments, mounted read-only at SANDBOX_ATTACHMENTS_DIR. */
  attachmentsDir?: string
}

/** Reject a path that leaves `root`, so host-shell mode can't write anywhere. */
function assertContained(root: string, candidate: string, action: string): void {
  if (containedIn(root, path.resolve(candidate))) return
  throw outsideWorkspace(action, candidate)
}

function outsideWorkspace(action: string, candidate: string): Error {
  return new Error(
    `Refusing to ${action} outside the workspace folder: ${candidate}. ` +
      'All file operations must stay inside the workspace.',
  )
}

type WriteRoots = { writable: string[]; readOnly: string[] }

function writeRoots(
  workingDir: string,
  folders: readonly ResolvedMountedFolder[],
  locate: (folder: ResolvedMountedFolder) => string,
): WriteRoots {
  return {
    writable: [workingDir, ...folders.filter(isWritable).map(locate)],
    readOnly: folders.filter((folder) => !isWritable(folder)).map(locate),
  }
}

/** Refuse a write unless the path, and where its symlinks really lead, stay in a writable root. */
async function assertReallyContained(
  roots: WriteRoots,
  candidate: string,
  action: string,
): Promise<void> {
  const resolved = path.resolve(candidate)
  const destination = await realDestination(resolved)
  for (const folder of roots.readOnly) {
    const real = await realDestination(folder)
    if (containedIn(folder, resolved) || containedIn(real, destination)) {
      throw readOnlyRefusal(action, candidate, folder, roots.writable[0])
    }
  }
  const realRoots = await Promise.all(roots.writable.map((root) => realDestination(root)))
  if (
    roots.writable.some((root) => containedIn(root, resolved)) &&
    realRoots.some((root) => containedIn(root, destination))
  ) {
    return
  }
  throw outsideWorkspace(action, candidate)
}

/**
 * Reject a write to a file a one-file session was never meant to produce.
 *
 * `relativePath` is already workspace-relative and POSIX-separated. The refusal
 * is written for the model to act on rather than to give up on: it is the only
 * thing standing between "put the whole game in `index.html`" as an instruction
 * and a small model that writes `index.html` plus a `game.js` anyway — which
 * leaves a game whose code never loads, and a hand-off summary that promises the
 * next agent one file.
 */
function assertWritableFile(relativePath: string, writableFiles: string[], action: string): void {
  const allowed = writableFiles.map((file) => file.split('\\').join('/').replace(/^\.\//, ''))
  if (allowed.includes(relativePath)) return
  const list = allowed.map((file) => `\`${file}\``).join(', ')
  throw new Error(
    `Refusing to ${action} ${relativePath}: this session writes ${list} and nothing else. ` +
      `Put the whole thing in ${allowed.length === 1 ? allowed[0] : 'those files'} instead — ` +
      'a second file is not loaded and the work in it is lost.',
  )
}

/**
 * Undo the host resolver's rewriting of a sandbox path.
 *
 * Pi resolves every path a tool is called with through `node:path` before
 * handing it to these operations. On Windows that is the win32 resolver, which
 * turns the POSIX sandbox path `/mnt/files/index.html` into
 * `C:\mnt\files\index.html` — a drive letter the virtual filesystem has never
 * heard of and separators it does not split on, so every read, write, list and
 * search misses. Stripping the drive and restoring `/` puts the path back in
 * the namespace the mounts are keyed by. On a POSIX host nothing is rewritten
 * and the path arrives here unchanged.
 */
function toSandboxPath(candidate: string): string {
  return candidate
    .replace(/^[A-Za-z]:/, '')
    .split('\\')
    .join('/')
}

function insideSandboxRoot(root: string, candidate: string, workdir = SANDBOX_WORKDIR): boolean {
  const relative = path.posix.relative(root, path.posix.resolve(workdir, candidate))
  return relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative))
}

/**
 * Same check for sandbox paths, which are always POSIX-style regardless of the
 * host platform (on Windows `path.relative` would mangle them).
 */
function assertInsideSandboxRoots(
  roots: string[],
  candidate: string,
  action: string,
  workdir = SANDBOX_WORKDIR,
): void {
  if (roots.some((root) => insideSandboxRoot(root, candidate, workdir))) return
  // Without this the write would land in the sandbox's throwaway in-memory root
  // instead of the mounted workspace, and the model would be told it succeeded.
  throw new Error(
    `Refusing to ${action} outside the workspace: ${candidate}. Everything must stay under ` +
      `${roots.join(' or ')}; ${workdir} is the workspace folder.`,
  )
}

function readOnlyRefusal(
  action: string,
  candidate: string,
  mountPoint: string,
  workingDir = SANDBOX_WORKDIR,
): Error {
  return new Error(
    `Refusing to ${action} ${candidate}: ${mountPoint} is a read-only Mounted Folder. The ` +
      'user has not allowed changes there, so retrying will not help. Tell the user, or ' +
      `write the file in ${workingDir} instead.`,
  )
}

function assertSandboxWritable(roots: WriteRoots, candidate: string, action: string): void {
  const [workdir] = roots.writable
  const readOnlyRoot = roots.readOnly.find((root) => insideSandboxRoot(root, candidate, workdir))
  if (readOnlyRoot) throw readOnlyRefusal(action, candidate, readOnlyRoot, workdir)
  assertInsideSandboxRoots(roots.writable, candidate, action, workdir)
}

/**
 * The read-only overlay names only the mount-relative path in its EROFS, which the shell
 * passes on; restate it with the mount point so the model knows which folder refused.
 */
function namingReadOnlyMount(fs: IFileSystem, mountPoint: string, workdir: string): IFileSystem {
  return new Proxy(fs, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        const restated = (error: unknown): never => {
          const message = error instanceof Error ? error.message : String(error)
          const refused = /^EROFS\b.*?'([^']*)'/.exec(message)
          if (!refused) throw error
          throw readOnlyRefusal(
            'change',
            path.posix.join(mountPoint, refused[1]),
            mountPoint,
            workdir,
          )
        }
        try {
          const result = value.apply(target, args)
          return result instanceof Promise ? result.catch(restated) : result
        } catch (error) {
          return restated(error)
        }
      }
    },
  })
}

/**
 * just-bash's `ls` matches a glob the shell left unexpanded against `getAllPaths()`, which
 * walks every real mount's whole tree synchronously. Only the mount points are offered
 * instead: a pattern the shell could not expand matches nothing, as in a real shell.
 */
function withoutTreeEnumeration(vfs: IFileSystem, mountPoints: readonly string[]): IFileSystem {
  const structure = new Set(['/'])
  for (const mountPoint of mountPoints) {
    for (let dir = mountPoint; dir !== '/'; dir = path.posix.dirname(dir)) structure.add(dir)
  }
  return new Proxy(vfs, {
    get(target, property) {
      if (property === 'getAllPaths') return () => [...structure]
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

// ── Sandboxed mode ──────────────────────────────────────────────────────────

/**
 * Restate a host filesystem refusal in terms the model can act on.
 *
 * The virtual filesystem reports these with the mount-relative path — a write
 * to `/mnt/files/index.html` that the operating system refuses comes back as
 * `EPERM: write '/index.html'`. That reads like a bad argument, so the model
 * "fixes" the path and writes somewhere else entirely instead of reporting that
 * the folder is unusable. macOS produces exactly this for folders under
 * Documents, Desktop and Downloads.
 */
async function reportingHostDenials<T>(
  action: string,
  sandboxPath: string,
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const denial = /^(EPERM|EACCES|EROFS)\b/.exec(message)
    if (!denial) throw error
    throw new Error(
      `Cannot ${action} ${sandboxPath}: the operating system denied access to the workspace ` +
        `folder on disk (${denial[1]}). The path is correct, so retrying with a different one ` +
        `will not help. Report this to the user: the app needs permission for ${workspaceDir}, ` +
        'or they should pick a workspace folder outside a protected location (on macOS the ' +
        'Documents, Desktop and Downloads folders are protected).',
    )
  }
}

/**
 * Name the image format a file holds, from its leading bytes.
 *
 * Pi's `read` gives the model an image as an attachment it can actually look at,
 * but only if the operations it was handed can recognize one — otherwise the
 * bytes are decoded as UTF-8 and arrive as mojibake. Pi's own sniffer ships
 * with its read tool's default operations, which the sandbox replaces, and is
 * not exported, so this covers the formats that tool documents. Being too
 * generous is harmless: Pi re-validates the image and falls back to a text note.
 */
function imageMimeType(buffer: Buffer): string | null {
  const ascii = (offset: number, text: string): boolean =>
    buffer.length >= offset + text.length &&
    buffer.toString('latin1', offset, offset + text.length) === text

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'image/jpeg'
  }
  if (ascii(0, '\x89PNG\r\n\x1a\n')) return 'image/png'
  if (ascii(0, 'GIF')) return 'image/gif'
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return 'image/webp'
  if (ascii(0, 'BM')) return 'image/bmp'
  return null
}

/** Longest edge, in pixels, an image is scaled down to before the model sees it. */
const MAX_IMAGE_EDGE = 1024

/** What the read tool should do with a file's bytes. */
type ReadableImage =
  | { kind: 'image'; bytes: Buffer; mimeType: string }
  /** An image no one downstream can read; say so instead of shipping it. */
  | { kind: 'undecodable'; mimeType: string }
  /** Not an image: read it as text, as always. */
  | { kind: 'other' }

/** Stands in for an image the model cannot be shown, in Pi's own wording. */
function undecodableNote(mimeType: string): Buffer {
  return Buffer.from(
    `[Image omitted: this ${mimeType} file could not be decoded, so it cannot be shown to ` +
      'the model. Ask the user to re-save it as a plain PNG or JPEG.]',
  )
}

/**
 * Decide how a file's bytes reach the model.
 *
 * Pi caps image size itself, but its resizer runs Photon (WASM) in a worker
 * thread that cannot be loaded from the bundled main process. It fails, Pi
 * replaces the picture with "[Image omitted: could not be resized below the
 * inline image size limit.]", and an attached sprite silently never reaches the
 * model — which then guesses at what it was asked to look at. Electron decodes
 * images anyway, so the cap is applied here and Pi is told (`autoResizeImages:
 * false`) to inline whatever these operations return.
 *
 * Re-encoding is not only about size. Inference servers decode images with
 * minimal decoders, and llama.cpp answers an exotic PNG with a 400 that fails
 * the entire turn, so anything Electron can read is handed on as a plain PNG.
 * JPEG passes through untouched unless it had to shrink, since re-encoding a
 * photo only costs quality.
 *
 * Some images (1-bit and palette PNGs among them) defeat Electron's decoder as
 * well. Those are the ones llama.cpp would reject, so they are reported as
 * undecodable rather than forwarded — a note the model can talk about beats a
 * dead turn.
 */
function imageForModel(buffer: Buffer): ReadableImage {
  const mimeType = imageMimeType(buffer)
  if (!mimeType) return { kind: 'other' }

  const decoded = nativeImage.createFromBuffer(buffer)
  if (decoded.isEmpty()) return { kind: 'undecodable', mimeType }

  const { width, height } = decoded.getSize()
  const oversized = Math.max(width, height) > MAX_IMAGE_EDGE
  const image = oversized
    ? decoded.resize(width >= height ? { width: MAX_IMAGE_EDGE } : { height: MAX_IMAGE_EDGE })
    : decoded

  if (mimeType === 'image/jpeg') {
    return { kind: 'image', bytes: oversized ? image.toJPEG(85) : buffer, mimeType }
  }
  return { kind: 'image', bytes: image.toPNG(), mimeType: 'image/png' }
}

/**
 * Wrap a plain byte read so images arrive model-ready. Only the `read` tool
 * gets this: `edit` reads to write the result back, and must stay byte-exact.
 */
function imageAwareReadOperations(
  readFile: (absolutePath: string) => Promise<Buffer>,
  access: (absolutePath: string) => Promise<void>,
): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const raw = await readFile(absolutePath)
      const image = imageForModel(raw)
      if (image.kind === 'image') return image.bytes
      // Pi reads anything without an image MIME type as UTF-8 text, which is
      // the only way to get a note in front of the model from out here.
      if (image.kind === 'undecodable') return undecodableNote(image.mimeType)
      return raw
    },
    access,
    detectImageMimeType: async (absolutePath) => {
      const image = imageForModel(await readFile(absolutePath))
      return image.kind === 'image' ? image.mimeType : null
    },
  }
}

/**
 * Operations backed by the sandbox's virtual filesystem. Pi hands these
 * absolute sandbox paths (rooted at the workspace mount), which is exactly the
 * namespace the MountableFs understands, so no translation is needed.
 */
function sandboxFsOperations(
  vfs: IFileSystem,
  workspaceDir: string,
  roots: WriteRoots,
  writableFiles?: string[],
) {
  const [workdir] = roots.writable
  /** Guard a sandbox write against the session's fixed file list, if it has one. */
  const assertWritable = (absolutePath: string, action: string): void => {
    if (!writableFiles) return
    assertWritableFile(path.posix.relative(workdir, absolutePath), writableFiles, action)
  }

  const readFile = async (hostPath: string): Promise<Buffer> => {
    const absolutePath = toSandboxPath(hostPath)
    return await reportingHostDenials('read', absolutePath, workspaceDir, async () =>
      Buffer.from(await vfs.readFileBuffer(absolutePath)),
    )
  }

  const read: ReadOperations = imageAwareReadOperations(readFile, async (hostPath) => {
    const absolutePath = toSandboxPath(hostPath)
    if (!(await vfs.exists(absolutePath))) {
      throw new Error(`File not found: ${absolutePath}`)
    }
  })

  const write: WriteOperations = {
    writeFile: async (hostPath, content) => {
      const absolutePath = toSandboxPath(hostPath)
      assertSandboxWritable(roots, absolutePath, 'write')
      assertWritable(absolutePath, 'write')
      await reportingHostDenials('write', absolutePath, workspaceDir, async () => {
        await vfs.mkdir(path.posix.dirname(absolutePath), { recursive: true })
        await vfs.writeFile(absolutePath, content)
      })
    },
    mkdir: async (hostPath) => {
      const dir = toSandboxPath(hostPath)
      assertSandboxWritable(roots, dir, 'create a directory')
      await reportingHostDenials('create a directory at', dir, workspaceDir, async () => {
        await vfs.mkdir(dir, { recursive: true })
      })
    },
  }

  const edit: EditOperations = {
    // The raw read, not the read tool's: an edit writes back what it reads.
    readFile,
    writeFile: async (hostPath, content) => {
      const absolutePath = toSandboxPath(hostPath)
      assertSandboxWritable(roots, absolutePath, 'edit')
      assertWritable(absolutePath, 'edit')
      await reportingHostDenials('edit', absolutePath, workspaceDir, async () => {
        await vfs.writeFile(absolutePath, content)
      })
    },
    access: read.access,
  }

  const ls: LsOperations = {
    exists: (hostPath) => vfs.exists(toSandboxPath(hostPath)),
    stat: async (hostPath) => {
      const stat = await vfs.stat(toSandboxPath(hostPath))
      return { isDirectory: () => stat.isDirectory }
    },
    readdir: (hostPath) => vfs.readdir(toSandboxPath(hostPath)),
  }

  // The sandbox has no `fd`, so globbing walks the virtual filesystem itself.
  const find: FindOperations = {
    exists: (hostPath) => vfs.exists(toSandboxPath(hostPath)),
    glob: async (pattern, hostCwd, options) => {
      const ignored = options.ignore.map(globToRegExp)
      const matches: string[] = []
      for await (const { relative } of globSandbox(vfs, toSandboxPath(hostCwd), pattern)) {
        if (ignored.some((ignore) => ignore.test(relative))) continue
        matches.push(relative)
        if (matches.length >= options.limit) break
      }
      return matches
    },
  }

  return { read, write, edit, find, ls }
}

/** Directories a search never descends into, as Pi's own find and grep don't. */
const SEARCH_SKIPPED_DIRS = new Set(['.git', 'node_modules'])

type WalkedEntry = { filePath: string; relative: string; isDirectory: boolean }

/**
 * Every entry below `root`, one directory listing at a time: `getAllPaths()` walks every
 * mount's whole real tree synchronously. Symlinks are listed, never followed.
 */
async function* walkSandbox(
  vfs: IFileSystem,
  root: string,
  relativeDir = '',
): AsyncGenerator<WalkedEntry> {
  const dir = relativeDir ? path.posix.join(root, relativeDir) : root
  let names: string[]
  try {
    names = [...(await vfs.readdir(dir))].sort()
  } catch {
    return
  }
  for (const name of names) {
    const filePath = path.posix.join(dir, name)
    const relative = relativeDir ? `${relativeDir}/${name}` : name
    let isDirectory: boolean
    try {
      isDirectory = (await vfs.lstat(filePath)).isDirectory
    } catch {
      continue
    }
    yield { filePath, relative, isDirectory }
    if (isDirectory && !SEARCH_SKIPPED_DIRS.has(name)) {
      yield* walkSandbox(vfs, root, relative)
    }
  }
}

async function* globSandbox(
  vfs: IFileSystem,
  root: string,
  pattern: string,
): AsyncGenerator<WalkedEntry> {
  const matcher = globToRegExp(pattern)
  for await (const entry of walkSandbox(vfs, root)) {
    if (matcher.test(entry.relative)) yield entry
  }
}

async function* grepCandidates(
  vfs: IFileSystem,
  searchRoot: string,
): AsyncGenerator<{ filePath: string; relative: string }> {
  if (!(await vfs.exists(searchRoot))) return
  if (!(await vfs.stat(searchRoot)).isDirectory) {
    yield { filePath: searchRoot, relative: path.posix.basename(searchRoot) }
    return
  }
  for await (const entry of walkSandbox(vfs, searchRoot)) {
    if (!entry.isDirectory) yield entry
  }
}

/** Cap on grep hits, mirroring the order of magnitude of Pi's own grep tool. */
const SANDBOX_GREP_LIMIT = 100

/**
 * The folders beside the Workspace are not inside it, so a model listing its working directory
 * by habit never sees them: the description and a note after that listing name them.
 */
function withFoldersBeside(
  ls: ToolDefinition,
  workdir: string,
  beside: readonly string[],
): ToolDefinition {
  if (beside.length === 0) return ls
  const named = beside.join(', ')
  return {
    ...ls,
    description:
      `${ls.description} The working directory is the Workspace; the Session's other folders` +
      ` are not inside it: ${named}. List them by path.`,
    execute: async (toolCallId, params, ...rest) => {
      const result = await ls.execute(toolCallId, params, ...rest)
      const requested = (params as { path?: string }).path ?? '.'
      if (path.posix.resolve(workdir, toSandboxPath(requested)) !== workdir) return result
      const note = `[Not in this folder: this Session also has ${named}. List them with ls <path>.]`
      return { ...result, content: [...result.content, { type: 'text', text: `\n${note}` }] }
    },
  } as ToolDefinition
}

/** Cap on find results, as Pi's own find tool. */
const SANDBOX_FIND_LIMIT = 1000

const defaultSearchDescription = (searchRoots: readonly string[]) =>
  searchRoots.length > 1
    ? `Defaults to every folder: ${searchRoots.join(', ')}.`
    : `Defaults to ${searchRoots[0]}.`

/** A path names one root to search; none means every root, the working directory first. */
function searchRootsFor(
  searchRoots: readonly string[],
  requested: string | undefined,
  action: string,
): string[] {
  const [workdir] = searchRoots
  if (!requested) return [...searchRoots]
  const searchRoot = path.posix.resolve(workdir, toSandboxPath(requested))
  assertInsideSandboxRoots([...searchRoots], searchRoot, action, workdir)
  return [searchRoot]
}

/** A hit under the working directory relative to it, as the model writes paths; others absolute. */
function shownPath(workdir: string, filePath: string): string {
  return insideSandboxRoot(workdir, filePath, workdir)
    ? path.posix.relative(workdir, filePath) || filePath
    : filePath
}

type FindParams = { pattern: string; path?: string; limit?: number }

/** Pi's find given a path; with none, every folder of the turn, the others by their /mnt path. */
function createSandboxFindTool(
  pi: PiModule,
  vfs: IFileSystem,
  searchRoots: string[],
  operations: FindOperations,
): ToolDefinition {
  const piFind = pi.createFindToolDefinition(searchRoots[0], { operations })
  if (searchRoots.length === 1) return piFind as ToolDefinition
  return {
    ...piFind,
    description: `${piFind.description} ${defaultSearchDescription(searchRoots)}`,
    parameters: Type.Object({
      pattern: Type.String({
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json' or 'src/**/*.spec.ts'.",
      }),
      path: Type.Optional(
        Type.String({
          description: `Directory to search in. ${defaultSearchDescription(searchRoots)}`,
        }),
      ),
      limit: Type.Optional(
        Type.Number({ description: `Maximum number of results (default ${SANDBOX_FIND_LIMIT}).` }),
      ),
    }),
    execute: (toolCallId, params: FindParams, signal, onUpdate, ctx) =>
      params.path
        ? piFind.execute(toolCallId, params, signal, onUpdate, ctx)
        : findEverywhere(pi, vfs, searchRoots, params, signal),
  } as ToolDefinition
}

/** Pi's own fd branch, which a custom glob does not reach, finishes its output this way. */
async function findEverywhere(
  pi: PiModule,
  vfs: IFileSystem,
  searchRoots: readonly string[],
  params: FindParams,
  signal: AbortSignal | undefined,
) {
  const [workdir] = searchRoots
  const limit = params.limit ?? SANDBOX_FIND_LIMIT
  const found: string[] = []
  search: for (const root of searchRoots) {
    for await (const { filePath } of globSandbox(vfs, root, params.pattern)) {
      if (signal?.aborted) throw new Error('Operation aborted')
      found.push(shownPath(workdir, filePath))
      if (found.length >= limit) break search
    }
  }
  if (signal?.aborted) throw new Error('Operation aborted')
  if (found.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No files found matching pattern' }],
      details: undefined,
    }
  }
  const truncation = pi.truncateHead(found.join('\n'), { maxLines: Number.MAX_SAFE_INTEGER })
  const notices: string[] = []
  const details: { resultLimitReached?: number; truncation?: typeof truncation } = {}
  if (found.length >= limit) {
    notices.push(
      `${limit} results limit reached. Use limit=${limit * 2} for more, or refine pattern`,
    )
    details.resultLimitReached = limit
  }
  if (truncation.truncated) {
    notices.push(`${pi.formatSize(pi.DEFAULT_MAX_BYTES)} limit reached`)
    details.truncation = truncation
  }
  const text = notices.length
    ? `${truncation.content}\n\n[${notices.join('. ')}]`
    : truncation.content
  return {
    content: [{ type: 'text' as const, text }],
    details: Object.keys(details).length > 0 ? details : undefined,
  }
}

const sandboxGrepSchema = (searchRoots: readonly string[]) =>
  Type.Object({
    pattern: Type.String({ description: 'Regular expression to search for.' }),
    path: Type.Optional(
      Type.String({
        description: `File or directory to search. ${defaultSearchDescription(searchRoots)}`,
      }),
    ),
    glob: Type.Optional(
      Type.String({ description: "Only search files matching this glob, e.g. '**/*.ts'." }),
    ),
    ignoreCase: Type.Optional(Type.Boolean({ description: 'Case-insensitive search.' })),
    literal: Type.Optional(
      Type.Boolean({ description: 'Treat the pattern as literal text instead of a regex.' }),
    ),
    limit: Type.Optional(
      Type.Number({ description: `Maximum number of matches (default ${SANDBOX_GREP_LIMIT}).` }),
    ),
  })

/**
 * A grep tool that searches the sandbox's virtual filesystem.
 *
 * Pi's own grep tool always shells out to ripgrep against the REAL filesystem —
 * its `operations` only supply context lines — so in sandboxed mode it would
 * both fail on the virtual workspace path and be able to read host files. This
 * replacement walks the mounted workspace instead, which is the only thing the
 * sandbox is allowed to see.
 */
function createSandboxGrepTool(
  pi: PiModule,
  vfs: IFileSystem,
  searchRoots: string[],
): ToolDefinition {
  const [workdir] = searchRoots
  return pi.defineTool({
    name: 'grep',
    label: 'grep',
    description:
      'Search file contents for a pattern. Returns matching lines with file paths and line ' +
      `numbers. Searches ${searchRoots.join(' and ')} only.`,
    promptSnippet: 'Search file contents by regex',
    parameters: sandboxGrepSchema(searchRoots),
    execute: async (_toolCallId, params) => {
      const roots = searchRootsFor(searchRoots, params.path, 'search')
      const limit = params.limit ?? SANDBOX_GREP_LIMIT
      const expression = new RegExp(
        params.literal ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : params.pattern,
        params.ignoreCase ? 'i' : '',
      )
      const globMatcher = params.glob ? globToRegExp(params.glob) : null

      const lines: string[] = []
      let truncated = false
      search: for (const searchRoot of roots) {
        for await (const { filePath, relative: underRoot } of grepCandidates(vfs, searchRoot)) {
          if (globMatcher && !globMatcher.test(underRoot)) continue
          let content: string
          try {
            content = await vfs.readFile(filePath)
          } catch {
            continue
          }
          const shown = shownPath(workdir, filePath)
          for (const [index, line] of content.split('\n').entries()) {
            if (!expression.test(line)) continue
            if (lines.length >= limit) {
              truncated = true
              break search
            }
            lines.push(`${shown}:${index + 1}:${line}`)
          }
        }
      }

      const text = lines.length
        ? `${lines.join('\n')}${truncated ? `\n… truncated at ${limit} matches` : ''}`
        : 'No matches found.'
      return { content: [{ type: 'text', text }], details: undefined }
    },
  }) as ToolDefinition
}

/**
 * Translate a glob pattern to a RegExp: `**` spans separators, `*` and `?` stop
 * at them. Enough for the find tool's patterns without pulling in a glob lib
 * that would want a real filesystem.
 */
function globToRegExp(pattern: string): RegExp {
  let expression = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        // `**/` should also match zero directories.
        if (pattern[index + 2] === '/') {
          expression += '(?:.*/)?'
          index += 2
        } else {
          expression += '.*'
          index += 1
        }
      } else {
        expression += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      expression += '[^/]'
      continue
    }
    expression += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${expression}$`)
}

/** A sandbox mount point paired with the host folder it is backed by. */
type SandboxMountMap = { sandbox: string; host: string }[]

function sandboxHostPath(mounts: SandboxMountMap, sandboxPath: string): string | undefined {
  const resolved = path.posix.resolve('/', toSandboxPath(sandboxPath))
  for (const { sandbox, host } of mounts) {
    const relative = path.posix.relative(sandbox, resolved)
    if (relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative))) {
      return path.join(host, relative)
    }
  }
  return undefined
}

/**
 * Record the pre-turn state of everything written through the sandbox's
 * filesystem, before the write happens — one choke point for the `write` and
 * `edit` tools and for the shell's `rm`, `mv`, `cp` and redirects alike (all
 * mutate through the virtual filesystem; see workspaceJournal.ts).
 */
function journalingVfs(vfs: IFileSystem, sessionId: string, mounts: SandboxMountMap): IFileSystem {
  const record = (sandboxPath: unknown): void => {
    if (typeof sandboxPath !== 'string') return
    const hostPath = sandboxHostPath(mounts, sandboxPath)
    if (hostPath) recordWorkspaceWrite(sessionId, hostPath)
  }
  return new Proxy(vfs, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args: unknown[]) => {
        try {
          switch (property) {
            case 'writeFile':
            case 'appendFile':
            case 'mkdir':
            case 'rm':
            case 'chmod':
              record(args[0])
              break
            case 'mv':
              // The source disappears, so its pre-state is captured too.
              record(args[0])
              record(args[1])
              break
            case 'cp':
            case 'symlink':
            case 'link':
              record(args[1])
              break
            default:
              break
          }
        } catch (error) {
          logger.warn(`journal: sandbox write not recorded: ${error}`, LOG_SOURCE)
        }
        return (value as (...fnArgs: unknown[]) => unknown).apply(target, args)
      }
    },
  })
}

function createSandboxAccess(
  pi: PiModule,
  justBash: JustBashModule,
  options: AgentToolAccessOptions,
): AgentToolAccess {
  const { workspaceDir, skills } = options
  const workdir = options.workspaceMount ?? SANDBOX_WORKDIR
  const vfs = new justBash.MountableFs()
  vfs.mount(workdir, new justBash.ReadWriteFs({ root: workspaceDir }))
  vfs.mount(
    SANDBOX_SKILLS_DIR,
    new justBash.InMemoryFs(Object.fromEntries(skills.map((s) => [s.relativePath, s.content]))),
  )
  const mountedFolders = options.mountedFolders ?? []
  const roots = writeRoots(workdir, mountedFolders, mountedFolderSandboxPath)
  const mountPoints = mountedFolders.map((folder) => {
    const mountPoint = mountedFolderSandboxPath(folder)
    if (isWritable(folder)) {
      vfs.mount(mountPoint, new justBash.ReadWriteFs({ root: folder.hostPath }))
    } else {
      // The overlay's own mount point is where paths below it start once MountableFs strips its prefix.
      vfs.mount(
        mountPoint,
        namingReadOnlyMount(
          new justBash.OverlayFs({ root: folder.hostPath, mountPoint: '/', readOnly: true }),
          mountPoint,
          workdir,
        ),
      )
    }
    return mountPoint
  })
  if (options.attachmentsDir) {
    fs.mkdirSync(options.attachmentsDir, { recursive: true })
    const root = fs.realpathSync(options.attachmentsDir)
    vfs.mount(
      SANDBOX_ATTACHMENTS_DIR,
      namingReadOnlyMount(
        new justBash.OverlayFs({ root, mountPoint: '/', readOnly: true }),
        SANDBOX_ATTACHMENTS_DIR,
        workdir,
      ),
    )
    mountPoints.push(SANDBOX_ATTACHMENTS_DIR)
    roots.readOnly.push(SANDBOX_ATTACHMENTS_DIR)
  }
  const journalMounts: SandboxMountMap = [
    { sandbox: workdir, host: workspaceDir },
    ...mountedFolders
      .filter(isWritable)
      .map((folder) => ({ sandbox: mountedFolderSandboxPath(folder), host: folder.hostPath })),
  ]
  const journaledVfs = options.sessionId
    ? journalingVfs(vfs, options.sessionId, journalMounts)
    : vfs
  const bashEnv = new justBash.Bash({
    fs: withoutTreeEnumeration(journaledVfs, [workdir, SANDBOX_SKILLS_DIR, ...mountPoints]),
    cwd: workdir,
    env: { HOME: SANDBOX_HOME, PWD: workdir },
    // just-bash's secondary hardening layer patches Module._load while a script
    // runs; the Electron main bundle is CJS with externalized dependencies, so
    // lazy require() calls inside the execution context (ReadWriteFs reaching
    // node:fs) trip it. The real isolation here is the ReadWriteFs root.
    defenseInDepth: false,
  })

  const operations = sandboxFsOperations(journaledVfs, workspaceDir, roots, options.writableFiles)
  const bash: BashOperations = {
    // just-bash resolves the whole script in-process and returns its output at
    // once, so there is a single onData call rather than incremental streaming.
    exec: async (command, cwd, { onData, signal, env }) => {
      const result = await bashEnv.exec(command, {
        cwd: toSandboxPath(cwd),
        ...(env ? { env: env as Record<string, string> } : {}),
        ...(signal ? { signal } : {}),
      })
      const output = `${result.stdout}${result.stderr}`
      if (output) onData(Buffer.from(output))
      return { exitCode: result.exitCode }
    },
  }

  return {
    cwd: workdir,
    skillsRoot: SANDBOX_SKILLS_DIR,
    definitions: [
      pi.createReadToolDefinition(workdir, {
        operations: operations.read,
        autoResizeImages: false,
      }),
      pi.createWriteToolDefinition(workdir, { operations: operations.write }),
      pi.createEditToolDefinition(workdir, { operations: operations.edit }),
      pi.createBashToolDefinition(workdir, { operations: bash }),
      createSandboxGrepTool(pi, vfs, [workdir, ...mountPoints]),
      createSandboxFindTool(pi, vfs, [workdir, ...mountPoints], operations.find),
      withFoldersBeside(
        pi.createLsToolDefinition(workdir, { operations: operations.ls }) as ToolDefinition,
        workdir,
        [
          ...mountedFolders.map(
            (folder) =>
              `${mountedFolderSandboxPath(folder)} (${isWritable(folder) ? 'read-write' : 'read-only'})`,
          ),
          ...(options.attachmentsDir ? [`${SANDBOX_ATTACHMENTS_DIR} (read-only)`] : []),
        ],
      ),
    ] as ToolDefinition[],
    dispose: async () => {},
  }
}

// ── Host-shell mode ─────────────────────────────────────────────────────────

/**
 * Pi's own local operations, but with writes and edits confined to the
 * workspace and the shell pinned to it. Reads are left unrestricted on purpose:
 * a coding agent legitimately reads system headers, installed packages and
 * toolchain files, and read access is what the user already granted the app.
 */
function createHostShellAccess(pi: PiModule, options: AgentToolAccessOptions): AgentToolAccess {
  const { workspaceDir } = options
  const roots = writeRoots(workspaceDir, options.mountedFolders ?? [], (folder) => folder.hostPath)
  return {
    cwd: workspaceDir,
    skillsRoot: options.skillsDir,
    definitions: [
      pi.createReadToolDefinition(workspaceDir, {
        operations: hostReadOperations(workspaceDir),
        autoResizeImages: false,
      }),
      pi.createWriteToolDefinition(workspaceDir, {
        operations: guardedWriteOperations(
          workspaceDir,
          roots,
          options.writableFiles,
          options.sessionId,
        ),
      }),
      pi.createEditToolDefinition(workspaceDir, {
        operations: guardedEditOperations(
          workspaceDir,
          roots,
          options.writableFiles,
          options.sessionId,
        ),
      }),
      pi.createBashToolDefinition(workspaceDir, {
        // Every command starts in the workspace, whatever cwd Pi passes.
        spawnHook: (context) => ({ ...context, cwd: workspaceDir }),
      }),
      pi.createGrepToolDefinition(workspaceDir),
      pi.createFindToolDefinition(workspaceDir),
      pi.createLsToolDefinition(workspaceDir),
    ] as ToolDefinition[],
    dispose: async () => {},
  }
}

/**
 * Pi's local read, kept unrestricted (see createHostShellAccess) but routed
 * through the same image handling the sandbox uses.
 */
function hostReadOperations(workspaceDir: string): ReadOperations {
  const readFile = async (absolutePath: string): Promise<Buffer> =>
    await reportingHostDenials(
      'read',
      absolutePath,
      workspaceDir,
      async () => await fsp.readFile(absolutePath),
    )
  return imageAwareReadOperations(readFile, async (absolutePath) => {
    await fsp.access(absolutePath)
  })
}

function guardedWriteOperations(
  workspaceDir: string,
  roots: WriteRoots,
  writableFiles?: string[],
  sessionId?: string,
): WriteOperations {
  // The host shell's own writes bypass the tool seams, so recording here covers
  // only `write` and `edit`; a turn that also used the shell is marked
  // unsandboxed in its journal and never offered a rollback (workspaceJournal.ts).
  const record = (absolutePath: string): void => {
    if (sessionId) recordWorkspaceWrite(sessionId, absolutePath)
  }
  return {
    writeFile: async (absolutePath, content) => {
      await assertReallyContained(roots, absolutePath, 'write')
      assertHostWritable(workspaceDir, absolutePath, writableFiles, 'write')
      record(absolutePath)
      await reportingHostDenials('write', absolutePath, workspaceDir, async () => {
        await fsp.mkdir(path.dirname(absolutePath), { recursive: true })
        await fsp.writeFile(absolutePath, content, 'utf8')
      })
    },
    mkdir: async (dir) => {
      await assertReallyContained(roots, dir, 'create a directory')
      record(dir)
      await reportingHostDenials('create a directory at', dir, workspaceDir, async () => {
        await fsp.mkdir(dir, { recursive: true })
      })
    },
  }
}

/** Host-path form of {@link assertWritableFile}; a no-op for an open session. */
function assertHostWritable(
  workspaceDir: string,
  absolutePath: string,
  writableFiles: string[] | undefined,
  action: string,
): void {
  if (!writableFiles) return
  const relative = path.relative(workspaceDir, path.resolve(absolutePath)).split('\\').join('/')
  assertWritableFile(relative, writableFiles, action)
}

function guardedEditOperations(
  workspaceDir: string,
  roots: WriteRoots,
  writableFiles?: string[],
  sessionId?: string,
): EditOperations {
  const record = (absolutePath: string): void => {
    if (sessionId) recordWorkspaceWrite(sessionId, absolutePath)
  }
  return {
    readFile: async (absolutePath) =>
      await reportingHostDenials(
        'read',
        absolutePath,
        workspaceDir,
        async () => await fsp.readFile(absolutePath),
      ),
    writeFile: async (absolutePath, content) => {
      await assertReallyContained(roots, absolutePath, 'edit')
      assertHostWritable(workspaceDir, absolutePath, writableFiles, 'edit')
      record(absolutePath)
      await reportingHostDenials('edit', absolutePath, workspaceDir, async () => {
        await fsp.writeFile(absolutePath, content, 'utf8')
      })
    },
    access: async (absolutePath) => {
      await assertReallyContained(roots, absolutePath, 'edit')
      await fsp.access(absolutePath)
    },
  }
}

/**
 * Build the file/shell tools for a turn. `unsandboxed` comes from the explicit
 * per-workspace consent the user gave in Agent Settings.
 */
export async function createAgentToolAccess(
  options: AgentToolAccessOptions,
): Promise<AgentToolAccess> {
  const pi = await loadPi()
  const access = options.unsandboxed
    ? createHostShellAccess(pi, options)
    : createSandboxAccess(pi, await loadJustBash(), options)
  const definitions = keepTools(access.definitions, options.baseTools)
  logger.info(
    `agent tools: ${options.unsandboxed ? 'HOST SHELL' : 'sandboxed'} mode in ` +
      `${options.workspaceDir} (${definitions.map((tool) => tool.name).join(', ')})`,
    LOG_SOURCE,
  )
  return { ...access, definitions }
}

/**
 * Cut the toolbox down to what a session uses. Every tool costs its schema in
 * the prompt and invites the step that calls it, so a run that is one `write`
 * long is better off not being offered a shell, a search and an editor.
 */
function keepTools(definitions: ToolDefinition[], keep?: string[]): ToolDefinition[] {
  if (!keep) return definitions
  const wanted = new Set(keep)
  return definitions.filter((definition) => wanted.has(definition.name))
}

export const testables = {
  globToRegExp,
  containedIn,
  assertContained,
  assertInsideSandboxRoots,
  assertWritableFile,
  reportingHostDenials,
  toSandboxPath,
  imageForModel,
  MAX_IMAGE_EDGE,
}
