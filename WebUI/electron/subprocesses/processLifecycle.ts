import { ChildProcess } from 'node:child_process'
import * as childProcess from 'node:child_process'
import { promisify } from 'node:util'
import { appLoggerInstance } from '../logging/logger.ts'

const execAsync = promisify(childProcess.exec)
const execFileAsync = promisify(childProcess.execFile)

type AppLogger = Pick<typeof appLoggerInstance, 'info' | 'warn' | 'error'>

export type SpawnBackendOptions = Omit<childProcess.SpawnOptions, 'detached'>

/**
 * Spawn a long-lived backend so that its whole descendant tree can be killed
 * later.
 *
 * On POSIX `detached` makes the child a process-group leader, which is the only
 * thing that lets terminateProcessTree() reach its grandchildren: a plain
 * `kill(pid)` fells the leader alone and the OS reparents everything below it to
 * init, where it keeps holding ports and GPU memory. On Windows `detached` would
 * instead open a console window, and `taskkill /T` already walks the tree, so it
 * stays off there.
 *
 * The child is deliberately NOT unref()'d — we still want its exit events.
 */
export function spawnBackend(
  command: string,
  args: readonly string[],
  options: SpawnBackendOptions = {},
): ChildProcess {
  return childProcess.spawn(command, [...args], {
    ...options,
    detached: process.platform !== 'win32',
  })
}

/**
 * Signal a whole POSIX process group. Returns false when there is no group to
 * signal (the child was not spawned via spawnBackend, or it and its children are
 * already gone), so the caller can fall back to the direct child.
 */
function killProcessGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal)
    return true
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'ESRCH' || code === 'EPERM') return false
    throw e
  }
}

/**
 * Best-effort signal to a backend and everything it spawned. Use instead of
 * `proc.kill(signal)` for anything started with spawnBackend(); a bare kill
 * fells the leader and leaves its children behind.
 */
export function signalBackendTree(proc: ChildProcess, signal: NodeJS.Signals): void {
  if (
    process.platform !== 'win32' &&
    proc.pid !== undefined &&
    killProcessGroup(proc.pid, signal)
  ) {
    return
  }
  proc.kill(signal)
}

export interface TerminateProcessTreeOptions {
  /** Backend name, used as the logging tag. */
  name: string
  /** Optional extra label (e.g. 'LLM', 'ComfyUI') appended to the tag. */
  label?: string
  /** Grace period for a cooperative SIGTERM shutdown (POSIX only). Default 2000ms. */
  gracefulMs?: number
  /** How long to wait for the OS to reap the process after the force kill. Default 5000ms. */
  forceMs?: number
  appLogger?: AppLogger
}

/**
 * Reliably tear down a spawned backend process AND its descendants.
 *
 * The important fix over a plain `proc.kill()` is Windows: Node has no real
 * SIGTERM, and `ChildProcess.kill()` only signals the direct child, leaving the
 * descendant tree (ComfyUI's python workers, the uv subprocesses spawned by
 * ComfyUI-Manager, …) orphaned. An orphaned ComfyUI keeps holding its port and
 * GPU memory, so the next app launch — which picks a fresh free port — starts a
 * SECOND instance beside it and runs the GPU out of memory. We therefore go
 * straight to `taskkill /T /F` while the pid is still valid so the whole tree is
 * reaped in one shot (this also avoids the pid-reuse risk of killing after a
 * reported graceful exit).
 */
export async function terminateProcessTree(
  proc: ChildProcess,
  opts: TerminateProcessTreeOptions,
): Promise<void> {
  const { name, label, gracefulMs = 2000, forceMs = 5000 } = opts
  const appLogger = opts.appLogger ?? appLoggerInstance
  const tag = label ? `${name} ${label}` : name

  // Already gone.
  if (proc.exitCode !== null || proc.signalCode !== null) return

  const waitForExit = (ms: number): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      if (proc.exitCode !== null || proc.signalCode !== null) {
        resolve(true)
        return
      }
      const timeout = setTimeout(() => resolve(false), ms)
      proc.once('exit', () => {
        clearTimeout(timeout)
        resolve(true)
      })
    })

  if (process.platform === 'win32' && proc.pid !== undefined) {
    // No graceful SIGTERM dance on Windows: signalling the parent leaves the
    // tree running, and if the parent happens to exit we'd never reach the tree
    // kill. Reap the whole tree while the pid is valid.
    try {
      await execAsync(`taskkill /PID ${proc.pid} /T /F`)
    } catch (e) {
      // taskkill exits non-zero when the process is already gone — not fatal.
      appLogger.warn(`taskkill for ${tag} reported: ${e}`, name)
    }
    if (!(await waitForExit(forceMs))) {
      appLogger.warn(`${tag} not confirmed exited after taskkill`, name)
    }
    return
  }

  // POSIX: signal the whole process group so grandchildren die with their
  // leader. Backends spawned through spawnBackend() are group leaders; anything
  // else falls back to the direct child, which is what this used to do for all
  // of them (and what left ComfyUI's python workers and the OVMS sub-servers
  // running under init).
  // Cooperative shutdown first, then SIGKILL.
  signalBackendTree(proc, 'SIGTERM')
  if (await waitForExit(gracefulMs)) return

  appLogger.warn(`${tag} did not exit within ${gracefulMs}ms, force killing`, name)
  signalBackendTree(proc, 'SIGKILL')
  if (!(await waitForExit(forceMs))) {
    appLogger.warn(`${tag} not confirmed exited after SIGKILL`, name)
  }
}

export interface KillStaleProcessesOptions {
  name: string
  label?: string
  /**
   * Pids that must never be killed even when their command line matches — the
   * backends this session already owns. Without it, a sweep run after startup
   * would shoot down the very process it is guarding.
   */
  excludePids?: readonly number[]
  appLogger?: AppLogger
}

/**
 * Startup singleton guard: kill any process left over from a previous app
 * session whose command line contains `signature` (typically the backend's
 * python binary path, which is unique to that backend's environment directory).
 *
 * A clean shutdown reaps everything via terminateProcessTree(), but a hard crash
 * or force-quit of Electron can still leave a backend running. Calling this
 * BEFORE spawning guarantees a new launch never coexists with a stale instance
 * that would hold a port + GPU memory and cause an out-of-memory.
 */
export async function killStaleProcessesByCommandLine(
  signature: string,
  opts: KillStaleProcessesOptions,
): Promise<void> {
  const { name, label, excludePids = [] } = opts
  const appLogger = opts.appLogger ?? appLoggerInstance
  const tag = label ? `${name} ${label}` : name

  try {
    const matched = await findPidsByCommandLine(signature)
    const pids = matched.filter((pid) => !excludePids.includes(pid))
    if (pids.length === 0) return
    appLogger.warn(
      `Found ${pids.length} stale ${tag} process(es) (${pids.join(', ')}); terminating before start`,
      name,
    )
    for (const pid of pids) {
      try {
        if (process.platform === 'win32') {
          await execAsync(`taskkill /PID ${pid} /T /F`)
        } else if (!killProcessGroup(pid, 'SIGKILL')) {
          // Left over from a build that spawned without a process group.
          process.kill(pid, 'SIGKILL')
        }
      } catch (e) {
        appLogger.warn(`Failed to kill stale ${tag} pid ${pid}: ${e}`, name)
      }
    }
  } catch (e) {
    // Best-effort guard — never block startup on it.
    appLogger.warn(`Stale-${tag}-process scan failed: ${e}`, name)
  }
}

export interface OrphanReaperTarget {
  /** Backend name, used as the logging tag. */
  name: string
  /**
   * Absolute paths that only this backend's own processes can carry in their
   * command line (its venv interpreter, its server binary). Being inside the
   * install directory is what keeps the match from straying onto unrelated
   * system processes.
   */
  signatures: readonly string[]
}

export interface ReapOrphansOptions {
  excludePids?: readonly number[]
  appLogger?: AppLogger
}

/**
 * Kill backends left running by a previous app session.
 *
 * Clean teardown reaps everything, but a SIGKILL of Electron or a crash cannot
 * be intercepted, and the survivors are invisible: the next launch picks a fresh
 * free port and starts a second instance beside the old one, so the ports walk
 * upwards (59000, 59001, 59002, …) while every orphan keeps its RAM and GPU
 * memory. Run this once at startup, before anything is spawned.
 */
export async function reapOrphansFromPreviousSession(
  targets: readonly OrphanReaperTarget[],
  opts: ReapOrphansOptions = {},
): Promise<void> {
  for (const target of targets) {
    for (const signature of target.signatures) {
      await killStaleProcessesByCommandLine(signature, {
        name: target.name,
        label: 'orphan from a previous session',
        excludePids: opts.excludePids,
        appLogger: opts.appLogger,
      })
    }
  }
}

async function findPidsByCommandLine(signature: string): Promise<number[]> {
  if (process.platform === 'win32') {
    // Escape single quotes for the PowerShell string literal.
    const escaped = signature.replace(/'/g, "''")
    const { stdout } = await execAsync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${escaped}*' } | Select-Object -ExpandProperty ProcessId"`,
    )
    return parsePids(stdout).filter((pid) => pid !== process.pid)
  }
  // POSIX: pgrep -f matches against the full command line. Run it without a
  // shell, otherwise the `sh -c pgrep …` wrapper carries the signature in its
  // own command line and pgrep reports that shell as a match.
  try {
    const { stdout } = await execFileAsync('pgrep', ['-f', '--', signature])
    return parsePids(stdout).filter((pid) => pid !== process.pid)
  } catch (e) {
    // pgrep exits 1 when nothing matches — that's not an error for us.
    if ((e as { code?: number }).code === 1) return []
    throw e
  }
}

function parsePids(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0)
}

export type WaitForServerReadyOptions = {
  /** Component name, used as the log source. */
  name: string
  /** Health probe attempts before giving up. */
  maxAttempts?: number
  /** Delay between attempts. */
  delayMs?: number
  /** Per-request timeout for the health probe. */
  requestTimeoutMs?: number
  /**
   * Returns an actionable error message if the server has reported a fatal
   * startup error (e.g. ran out of memory), otherwise null. Checked before each
   * probe so the wait aborts early with a useful message instead of timing out.
   */
  getStartupError?: () => string | null
  /**
   * When true, capture the process exit code/signal and tail of stderr to build
   * a richer crash diagnostic (covers OS-level kills like OOM/SIGSEGV that
   * `ChildProcess.killed` does not reflect).
   */
  captureExitDiagnostics?: boolean
  appLogger?: AppLogger
}

/**
 * Poll an HTTP health endpoint until the server responds 200, the process dies,
 * or `maxAttempts` is exhausted. Throws on every failure path so the caller can
 * surface an actionable error. An `'exit'` listener (not just `proc.killed`) is
 * used to detect OS-level kills.
 */
export async function waitForServerReadyOrThrow(
  healthUrl: string,
  proc: ChildProcess,
  opts: WaitForServerReadyOptions,
): Promise<void> {
  const {
    name,
    maxAttempts = 120,
    delayMs = 1000,
    requestTimeoutMs = 1000,
    getStartupError,
    captureExitDiagnostics = false,
  } = opts
  const appLogger = opts.appLogger ?? appLoggerInstance

  // process.killed only reflects signals sent by Node.js, so also track real
  // exits (OOM, SIGSEGV, etc.) via the 'exit' event.
  let processExited = false
  let exitCode: number | null = null
  let exitSignal: string | null = null
  const stderrChunks: string[] = []

  const onExit = (code: number | null, signal: string | null) => {
    processExited = true
    exitCode = code
    exitSignal = signal
  }
  proc.on('exit', onExit)

  const onStderr = (data: Buffer) => {
    stderrChunks.push(data.toString())
    // Keep only the last 20 chunks of stderr for diagnostics.
    if (stderrChunks.length > 20) stderrChunks.shift()
  }
  if (captureExitDiagnostics) proc.stderr?.on('data', onStderr)

  const isDead = () => processExited || proc.killed
  const deathMessage = (fallback: string): string => {
    if (!captureExitDiagnostics) return fallback
    const reason = exitSignal
      ? `killed by signal ${exitSignal}`
      : exitCode !== null
        ? `exit code ${exitCode}`
        : 'exit code null (killed by OS signal, possibly OOM)'
    const lastStderr = stderrChunks.join('').trim()
    const stderrSuffix = lastStderr ? `\nLast stderr output:\n${lastStderr.slice(-2000)}` : ''
    return `${name} process crashed during startup (${reason})${stderrSuffix}`
  }

  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Abort early with an actionable message if the server reported a fatal
      // startup error (e.g. not enough memory for the requested context size).
      const startupError = getStartupError?.()
      if (startupError) {
        appLogger.error(startupError, name)
        throw new Error(startupError)
      }

      if (isDead()) {
        const msg = deathMessage(`Process for ${name} exited before server became ready`)
        appLogger.warn(`Process for ${name} is not alive, aborting health check: ${msg}`, name)
        throw new Error(msg)
      }

      let healthy = false
      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(requestTimeoutMs),
        })
        healthy = response.ok
      } catch (_error) {
        // Server not up yet — fall through to the liveness check and retry.
      }

      if (healthy) {
        // Double-check the process is still alive before accepting success.
        if (isDead()) {
          const msg = deathMessage(`Process for ${name} exited after health check succeeded`)
          appLogger.warn(msg, name)
          throw new Error(msg)
        }
        appLogger.info(`Server ready at ${healthUrl}`, name)
        return
      }

      if (isDead()) {
        const msg = deathMessage(`Process for ${name} exited during health check wait`)
        appLogger.warn(msg, name)
        throw new Error(msg)
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    throw new Error(`Server failed to start within ${(maxAttempts * delayMs) / 1000} seconds`)
  } finally {
    proc.removeListener('exit', onExit)
    if (captureExitDiagnostics) proc.stderr?.removeListener('data', onStderr)
  }
}
