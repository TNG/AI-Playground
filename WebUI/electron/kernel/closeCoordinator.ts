import type { CloseChoice, CloseQuestion, InFlightWorkItem } from '@/types/lifecycleIpc'

// Every user-initiated close ends here: no In-flight Work quits, otherwise
// the window is asked. There is no hidden window and no background mode.

export type CloseAnswer = CloseChoice | 'no-window'
export type CloseOutcome = 'quit' | 'kept-open'

export type CloseCoordinatorDeps = {
  listInFlightWork: () => Promise<InFlightWorkItem[]>
  askWindow: (question: CloseQuestion) => Promise<CloseAnswer>
  /** Replaces the list in the open question; an empty list never answers it. */
  showRefreshedQuestion: (question: CloseQuestion) => void
  /** Calls `refresh` periodically until the returned stop function runs. */
  whileAsking: (refresh: () => Promise<void>) => () => void
  quit: () => void
  minimizeWindow: () => void
  suspendSchedules: () => void
  resumeSchedules: () => void
}

export const CLOSE_QUESTION_LINES = 5

export function closeQuestion(work: InFlightWorkItem[]): CloseQuestion {
  return {
    items: work.slice(0, CLOSE_QUESTION_LINES),
    more: Math.max(0, work.length - CLOSE_QUESTION_LINES),
  }
}

export function createCloseCoordinator(deps: CloseCoordinatorDeps) {
  let open: Promise<CloseOutcome> | null = null

  async function ask(work: InFlightWorkItem[]): Promise<CloseAnswer> {
    let shown = JSON.stringify(closeQuestion(work))
    let asking = true
    const stop = deps.whileAsking(async () => {
      const latest = await deps.listInFlightWork().catch(() => null)
      if (!asking || !latest) return
      const next = closeQuestion(latest)
      const serialized = JSON.stringify(next)
      if (serialized === shown) return
      shown = serialized
      deps.showRefreshedQuestion(next)
    })
    try {
      return await deps.askWindow(closeQuestion(work))
    } catch {
      return 'no-window'
    } finally {
      asking = false
      stop()
    }
  }

  async function decide(): Promise<CloseOutcome> {
    const work = await deps.listInFlightWork()
    if (work.length > 0) {
      deps.suspendSchedules()
      const answer = await ask(work)
      if (answer === 'keep' || answer === 'minimize') {
        deps.resumeSchedules()
        if (answer === 'minimize') deps.minimizeWindow()
        return 'kept-open'
      }
    }
    deps.quit()
    return 'quit'
  }

  return {
    requestClose(): Promise<CloseOutcome> {
      open ??= decide().finally(() => {
        open = null
      })
      return open
    },
  }
}

/** A crashed renderer must not leave its In-flight Work report standing (every close would ask). */
export function bindRendererWorkReset(
  webContents: { once: (event: 'destroyed', listener: () => void) => void },
  setWork: (work: InFlightWorkItem[]) => void,
): void {
  webContents.once('destroyed', () => setWork([]))
}
