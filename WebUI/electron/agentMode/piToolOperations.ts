import path from 'node:path'
import fsp from 'node:fs/promises'
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
import { appLoggerInstance } from '../logging/logger.ts'
import { loadJustBash, loadPi, type JustBashModule, type PiModule } from './piRuntime.ts'
import type { AgentSkill } from './piCustomTools.ts'

// ── Agent Mode file/shell access ─────────────────────────────────────────────
//
// Pi's built-in tools (read, write, edit, bash, grep, find, ls) each accept
// pluggable `*Operations`, so the host decides what "the filesystem" and "the
// shell" mean without Pi knowing. Two modes:
//
//  - sandboxed (default): every operation is served by a just-bash sandbox
//    whose virtual filesystem mounts ONLY the user-selected workspace folder
//    (real files, read-write) at `/workspace`. The emulated shell has python3
//    and js-exec enabled but no host process ever spawns, so nothing outside
//    the workspace is reachable — by construction, not by path checking.
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

/** Mount point (and Pi's cwd) of the workspace inside the sandbox. */
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
  /** Host directory holding the written SKILL.md files. */
  skillsDir: string
  skills: AgentSkill[]
}

function containedIn(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Reject a path that leaves `root`, so host-shell mode can't write anywhere. */
function assertContained(root: string, candidate: string, action: string): void {
  if (containedIn(root, path.resolve(candidate))) return
  throw new Error(
    `Refusing to ${action} outside the workspace folder: ${candidate}. ` +
      'All file operations must stay inside the workspace.',
  )
}

/**
 * Same check for sandbox paths, which are always POSIX-style regardless of the
 * host platform (on Windows `path.relative` would mangle them).
 */
function assertInsideSandboxWorkspace(candidate: string, action: string): void {
  const resolved = path.posix.resolve(SANDBOX_WORKDIR, candidate)
  const relative = path.posix.relative(SANDBOX_WORKDIR, resolved)
  if (relative === '' || (!relative.startsWith('..') && !path.posix.isAbsolute(relative))) return
  // Without this the write would land in the sandbox's throwaway in-memory root
  // instead of the mounted workspace, and the model would be told it succeeded.
  throw new Error(
    `Refusing to ${action} outside the workspace: ${candidate}. Everything must stay under ` +
      `${SANDBOX_WORKDIR}, which is the workspace folder.`,
  )
}

// ── Sandboxed mode ──────────────────────────────────────────────────────────

/**
 * Operations backed by the sandbox's virtual filesystem. Pi hands these
 * absolute sandbox paths (rooted at SANDBOX_WORKDIR), which is exactly the
 * namespace the MountableFs understands, so no translation is needed.
 */
function sandboxFsOperations(vfs: IFileSystem) {
  const read: ReadOperations = {
    readFile: async (absolutePath) => Buffer.from(await vfs.readFileBuffer(absolutePath)),
    access: async (absolutePath) => {
      if (!(await vfs.exists(absolutePath))) {
        throw new Error(`File not found: ${absolutePath}`)
      }
    },
  }

  const write: WriteOperations = {
    writeFile: async (absolutePath, content) => {
      assertInsideSandboxWorkspace(absolutePath, 'write')
      await vfs.mkdir(path.posix.dirname(absolutePath), { recursive: true })
      await vfs.writeFile(absolutePath, content)
    },
    mkdir: async (dir) => {
      assertInsideSandboxWorkspace(dir, 'create a directory')
      await vfs.mkdir(dir, { recursive: true })
    },
  }

  const edit: EditOperations = {
    readFile: read.readFile,
    writeFile: async (absolutePath, content) => {
      assertInsideSandboxWorkspace(absolutePath, 'edit')
      await vfs.writeFile(absolutePath, content)
    },
    access: read.access,
  }

  const ls: LsOperations = {
    exists: (absolutePath) => vfs.exists(absolutePath),
    stat: async (absolutePath) => {
      const stat = await vfs.stat(absolutePath)
      return { isDirectory: () => stat.isDirectory }
    },
    readdir: (absolutePath) => vfs.readdir(absolutePath),
  }

  // The sandbox has no `fd`, so globbing walks the virtual filesystem itself.
  const find: FindOperations = {
    exists: (absolutePath) => vfs.exists(absolutePath),
    glob: async (pattern, cwd, options) => {
      const matcher = globToRegExp(pattern)
      const root = cwd.endsWith('/') ? cwd : `${cwd}/`
      const matches: string[] = []
      for (const candidate of vfs.getAllPaths()) {
        if (!candidate.startsWith(root)) continue
        const relative = candidate.slice(root.length)
        if (!matcher.test(relative)) continue
        if (options.ignore.some((ignored) => globToRegExp(ignored).test(relative))) continue
        matches.push(relative)
        if (matches.length >= options.limit) break
      }
      return matches
    },
  }

  return { read, write, edit, find, ls }
}

/** Cap on grep hits, mirroring the order of magnitude of Pi's own grep tool. */
const SANDBOX_GREP_LIMIT = 100

const sandboxGrepSchema = Type.Object({
  pattern: Type.String({ description: 'Regular expression to search for.' }),
  path: Type.Optional(
    Type.String({ description: `File or directory to search. Defaults to ${SANDBOX_WORKDIR}.` }),
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
function createSandboxGrepTool(pi: PiModule, vfs: IFileSystem): ToolDefinition {
  return pi.defineTool({
    name: 'grep',
    label: 'grep',
    description:
      'Search file contents for a pattern. Returns matching lines with file paths and line ' +
      'numbers. Searches the workspace only.',
    promptSnippet: 'Search file contents by regex',
    parameters: sandboxGrepSchema,
    execute: async (_toolCallId, params) => {
      const searchRoot = path.posix.resolve(SANDBOX_WORKDIR, params.path ?? SANDBOX_WORKDIR)
      assertInsideSandboxWorkspace(searchRoot, 'search')
      const limit = params.limit ?? SANDBOX_GREP_LIMIT
      const expression = new RegExp(
        params.literal ? params.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : params.pattern,
        params.ignoreCase ? 'i' : '',
      )
      const globMatcher = params.glob ? globToRegExp(params.glob) : null

      const prefix = searchRoot.endsWith('/') ? searchRoot : `${searchRoot}/`
      const candidates = (await vfs.exists(searchRoot))
        ? (await vfs.stat(searchRoot)).isDirectory
          ? vfs.getAllPaths().filter((candidate) => candidate.startsWith(prefix))
          : [searchRoot]
        : []

      const lines: string[] = []
      let truncated = false
      for (const filePath of candidates) {
        if (globMatcher && !globMatcher.test(filePath.slice(prefix.length))) continue
        let content: string
        try {
          if ((await vfs.stat(filePath)).isDirectory) continue
          content = await vfs.readFile(filePath)
        } catch {
          continue
        }
        const relative = path.posix.relative(SANDBOX_WORKDIR, filePath) || filePath
        for (const [index, line] of content.split('\n').entries()) {
          if (!expression.test(line)) continue
          if (lines.length >= limit) {
            truncated = true
            break
          }
          lines.push(`${relative}:${index + 1}:${line}`)
        }
        if (truncated) break
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

function createSandboxAccess(
  pi: PiModule,
  justBash: JustBashModule,
  options: AgentToolAccessOptions,
): AgentToolAccess {
  const { workspaceDir, skills } = options
  const vfs = new justBash.MountableFs()
  vfs.mount(SANDBOX_WORKDIR, new justBash.ReadWriteFs({ root: workspaceDir }))
  vfs.mount(
    SANDBOX_SKILLS_DIR,
    new justBash.InMemoryFs(Object.fromEntries(skills.map((s) => [s.relativePath, s.content]))),
  )
  const bashEnv = new justBash.Bash({
    fs: vfs,
    cwd: SANDBOX_WORKDIR,
    env: { HOME: SANDBOX_HOME, PWD: SANDBOX_WORKDIR },
    // Interpreters the model can actually use for scripting inside the sandbox.
    // There is deliberately no network and no node/npm here — that is what
    // host-shell mode is for.
    python: true,
    javascript: true,
    // just-bash's secondary hardening layer patches Module._load while a script
    // runs; the Electron main bundle is CJS with externalized dependencies, so
    // lazy require() calls inside the execution context (ReadWriteFs reaching
    // node:fs) trip it. The real isolation here is the ReadWriteFs root.
    defenseInDepth: false,
  })

  const operations = sandboxFsOperations(vfs)
  const bash: BashOperations = {
    // just-bash resolves the whole script in-process and returns its output at
    // once, so there is a single onData call rather than incremental streaming.
    exec: async (command, cwd, { onData, signal, env }) => {
      const result = await bashEnv.exec(command, {
        cwd,
        ...(env ? { env: env as Record<string, string> } : {}),
        ...(signal ? { signal } : {}),
      })
      const output = `${result.stdout}${result.stderr}`
      if (output) onData(Buffer.from(output))
      return { exitCode: result.exitCode }
    },
  }

  return {
    cwd: SANDBOX_WORKDIR,
    skillsRoot: SANDBOX_SKILLS_DIR,
    definitions: [
      pi.createReadToolDefinition(SANDBOX_WORKDIR, { operations: operations.read }),
      pi.createWriteToolDefinition(SANDBOX_WORKDIR, { operations: operations.write }),
      pi.createEditToolDefinition(SANDBOX_WORKDIR, { operations: operations.edit }),
      pi.createBashToolDefinition(SANDBOX_WORKDIR, { operations: bash }),
      createSandboxGrepTool(pi, vfs),
      pi.createFindToolDefinition(SANDBOX_WORKDIR, { operations: operations.find }),
      pi.createLsToolDefinition(SANDBOX_WORKDIR, { operations: operations.ls }),
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
  return {
    cwd: workspaceDir,
    skillsRoot: options.skillsDir,
    definitions: [
      pi.createReadToolDefinition(workspaceDir),
      pi.createWriteToolDefinition(workspaceDir, {
        operations: guardedWriteOperations(workspaceDir),
      }),
      pi.createEditToolDefinition(workspaceDir, {
        operations: guardedEditOperations(workspaceDir),
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

function guardedWriteOperations(workspaceDir: string): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      assertContained(workspaceDir, absolutePath, 'write')
      await fsp.mkdir(path.dirname(absolutePath), { recursive: true })
      await fsp.writeFile(absolutePath, content, 'utf8')
    },
    mkdir: async (dir) => {
      assertContained(workspaceDir, dir, 'create a directory')
      await fsp.mkdir(dir, { recursive: true })
    },
  }
}

function guardedEditOperations(workspaceDir: string): EditOperations {
  return {
    readFile: async (absolutePath) => await fsp.readFile(absolutePath),
    writeFile: async (absolutePath, content) => {
      assertContained(workspaceDir, absolutePath, 'edit')
      await fsp.writeFile(absolutePath, content, 'utf8')
    },
    access: async (absolutePath) => {
      assertContained(workspaceDir, absolutePath, 'edit')
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
  if (options.unsandboxed) {
    logger.info(`agent tools: HOST SHELL mode in ${options.workspaceDir}`, LOG_SOURCE)
    return createHostShellAccess(pi, options)
  }
  logger.info(`agent tools: sandboxed mode in ${options.workspaceDir}`, LOG_SOURCE)
  return createSandboxAccess(pi, await loadJustBash(), options)
}

export const testables = {
  globToRegExp,
  containedIn,
  assertContained,
  assertInsideSandboxWorkspace,
}
