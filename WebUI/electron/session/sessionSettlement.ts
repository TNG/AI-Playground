import { appLoggerInstance } from '../observability/logger'
import { emitSessionChanged } from '../kernel/kernelBus'
import {
  overviewOutcomePatch,
  recordOverviewOutcome,
  updateOverviewSummaryForTurn,
} from './overviewSummary'
import { readSession, sessionDocumentOf } from './sessions'
import { appendHistoryEntry, updateHistoryEntry, type NewHistoryEntry } from './sessionHistory'
import { localSummaryModel } from '@/lib/summariser'
import type { HistoryEntry, OverviewSummaryUpdate, Summariser } from '@/types/sessionIpc'

const LOG_SCOPE = 'sessions'

export type TurnSettlement = {
  /** Absent for a turn with no local model to write an Overview Summary with. */
  summariser?: Summariser
  /** The turn ran on a cloud model, so the summary waits for the next local turn. */
  cloudTurn?: boolean
  abortSignal?: AbortSignal
  /**
   * Runs after the turn is recorded but before the update's model call: a panel
   * media run hands the GPU back to chat here. Failure is logged, never thrown.
   */
  beforeSummary?: () => Promise<void>
  /**
   * The caller already admitted this work and holds the Turn Queue's place (a
   * panel media run), so the update loads the model but takes no second place.
   */
  summariserAdmitted?: boolean
}

function pendingReasonOf(options: TurnSettlement): OverviewSummaryUpdate['pendingReason'] {
  if (localSummaryModel(options.summariser)) return 'local'
  return options.cloudTurn ? 'cloud' : 'no-local'
}

async function rewriteOutcome(
  sessionId: string,
  entry: HistoryEntry,
  overviewUpdate: OverviewSummaryUpdate,
): Promise<HistoryEntry> {
  try {
    const updated = await updateHistoryEntry(sessionId, entry.id, { overviewUpdate })
    const file = await readSession(sessionId).catch(() => null)
    if (file) emitSessionChanged(sessionDocumentOf(file))
    return updated ?? entry
  } catch (error) {
    appLoggerInstance.warn(`turn's summary outcome not recorded: ${error}`, LOG_SCOPE)
    return entry
  }
}

/**
 * The one seam every turn kind settles through: its History Entry is appended
 * before the turn reports done, then an included Session's Overview Summary is
 * refreshed and the outcome written back onto the entry. Neither the append nor
 * the update can fail the turn.
 */
export async function settleTurn(
  sessionId: string,
  entry: NewHistoryEntry,
  options: TurnSettlement = {},
): Promise<HistoryEntry | undefined> {
  let included = false
  try {
    included = (await readSession(sessionId)).includedInOverviews
  } catch {
    // An unreadable Session still gets its entry attempted; the append reports the real error.
  }

  let written: HistoryEntry
  try {
    written = await appendHistoryEntry(
      sessionId,
      included && entry.status !== 'cancelled'
        ? {
            ...entry,
            overviewUpdate: { state: 'pending', pendingReason: pendingReasonOf(options) },
          }
        : entry,
    )
  } catch (error) {
    appLoggerInstance.warn(`turn not recorded in its Session: ${error}`, LOG_SCOPE)
    return undefined
  }
  if (!included) return written

  if (entry.status === 'cancelled') {
    return rewriteOutcome(sessionId, written, { state: 'skipped' })
  }

  const request = options.summariser
  if (localSummaryModel(request) && options.beforeSummary) {
    try {
      await options.beforeSummary()
    } catch (error) {
      appLoggerInstance.warn(`could not hand the GPU back before summarising: ${error}`, LOG_SCOPE)
    }
  }

  let outcome: Awaited<ReturnType<typeof updateOverviewSummaryForTurn>> = null
  try {
    outcome = await updateOverviewSummaryForTurn(
      sessionId,
      request ?? { language: 'en-US' },
      options.abortSignal,
      { admitted: options.summariserAdmitted },
    )
  } catch (error) {
    appLoggerInstance.warn(`Overview Summary update did not settle the turn: ${error}`, LOG_SCOPE)
  }

  if (!outcome) return written
  const patch = overviewOutcomePatch(outcome)
  try {
    const updated = await recordOverviewOutcome(sessionId, patch)
    return updated.find((entry) => entry.id === written.id) ?? written
  } catch (error) {
    appLoggerInstance.warn(`turn's summary outcome not recorded: ${error}`, LOG_SCOPE)
    return written
  }
}
