import { ChildProcess, exec } from 'node:child_process'
import { promisify } from 'node:util'
import { appLoggerInstance } from '../logging/logger.ts'

const execAsync = promisify(exec)

// Minimal logger surface so callers can pass their bound appLogger. Defaults to
// the shared instance when omitted.
type ProcLogger = {
  info(message: string, source?: string): void
  warn(message: string, source?: string): void
  error(message: string, source?: string): void
}

export type TerminateProcessTreeOptions = {
  /** Component name, used as the log source. */
  name: string
  /** Extra label distinguishing co-located processes (e.g. 'LLM', 'embedding'). */
  label?: string
  /** How long to wait for graceful SIGTERM exit before force killing. */
  gracefulMs?: number
  /** How long to wait for the OS to reap the process after force kill. */
  forceMs?: number
  appLogger?: ProcLogger
}

/**
 * Stop a child process and, on Windows, its entire descendant tree.
 *
 * SIGTERM → wait `gracefulMs` → (Windows) `taskkill /T /F`, else SIGKILL → wait
 * `forceMs`. Windows `ChildProcess.kill()` only signals the direct PID, so
 * descendants (uv subprocesses, embedded Python, OVMS workers) survive and keep
 * handles on the service directory and binaries — which makes a subsequent
 * reinstall fail to delete the directory (EPERM/EBUSY). `taskkill /T /F` tears
 * down the whole tree; we then wait for the OS to reap it and release handles.
 */
export async function terminateProcessTree(
  proc: ChildProcess,
  opts: TerminateProcessTreeOptions,
): Promise<void> {
  const { name, label, gracefulMs = 2000, forceMs = 5000 } = opts
  const appLogger = opts.appLogger ?? appLoggerInstance
  const tag = label ? `${name} ${label}` : name

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

  // Try graceful shutdown first with SIGTERM.
  proc.kill('SIGTERM')
  if (await waitForExit(gracefulMs)) return

  appLogger.warn(`Force killing ${tag} process tree`, name)
  if (process.platform === 'win32' && proc.pid !== undefined) {
    try {
      await execAsync(`taskkill /PID ${proc.pid} /T /F`)
    } catch (e) {
      // taskkill exits non-zero when the process is already gone — not fatal.
      appLogger.warn(`taskkill for ${tag} reported: ${e}`, name)
    }
  } else {
    proc.kill('SIGKILL')
  }

  if (!(await waitForExit(forceMs))) {
    appLogger.warn(`${tag} not confirmed exited after force kill`, name)
  }
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
  appLogger?: ProcLogger
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
