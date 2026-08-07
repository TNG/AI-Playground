import { appLoggerInstance } from './logging/logger.ts'

const LOG_SOURCE = 'shutdown'

/** Upper bound for the whole teardown, so a wedged backend cannot hang quit. */
const DEFAULT_TIMEOUT_MS = 15_000

type ShutdownLogger = Pick<typeof appLoggerInstance, 'info' | 'warn' | 'error'>

export type ShutdownStep = {
  /** Short label, used in the shutdown log lines. */
  name: string
  /** Any return value is awaited and discarded, so teardown calls can be passed through as-is. */
  run: () => unknown
}

export type ShutdownOptions = {
  timeoutMs?: number
  appLogger?: ShutdownLogger
}

const steps: ShutdownStep[] = []
let started = false
let inFlight: Promise<void> | null = null

/**
 * Register something that must be torn down before the app exits. Steps run in
 * registration order, so register from the outside in: windows first, the
 * backends that outlive them last.
 */
export function registerShutdownStep(step: ShutdownStep): void {
  steps.push(step)
}

/**
 * True from the moment teardown starts. Anything that restarts a child process
 * on exit (the langchain utility process) must check this, or it resurrects the
 * process we just killed.
 */
export function isShuttingDown(): boolean {
  return started
}

/**
 * Run every registered step exactly once. Safe to call from several exit paths
 * at once — later callers await the same run rather than starting a second one.
 */
export function shutdownBackends(options: ShutdownOptions = {}): Promise<void> {
  if (inFlight) return inFlight
  // Set before the first step runs, not after: runSteps() executes synchronously
  // up to its first await, and a step that kills a respawning child needs the
  // flag to already be true by then.
  started = true
  inFlight = runSteps(options)
  return inFlight
}

async function runSteps({
  timeoutMs = DEFAULT_TIMEOUT_MS,
  appLogger = appLoggerInstance,
}: ShutdownOptions): Promise<void> {
  const deadline = Date.now() + timeoutMs
  appLogger.info(`tearing down ${steps.length} step(s)`, LOG_SOURCE)

  for (const step of steps) {
    const remainingMs = deadline - Date.now()
    if (remainingMs <= 0) {
      appLogger.warn(`out of time before "${step.name}" could run`, LOG_SOURCE)
      continue
    }
    try {
      if (await ranWithin(step.run, remainingMs)) {
        appLogger.info(`${step.name} torn down`, LOG_SOURCE)
      } else {
        appLogger.warn(`${step.name} did not finish within ${remainingMs}ms`, LOG_SOURCE)
      }
    } catch (e) {
      // One failing backend must not strand the rest.
      appLogger.warn(`${step.name} failed to tear down: ${e}`, LOG_SOURCE)
    }
  }
}

async function ranWithin(run: ShutdownStep['run'], ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  const finished = (async () => {
    await run()
    return true
  })()
  try {
    return await Promise.race([finished, expired])
  } finally {
    clearTimeout(timer)
  }
}
