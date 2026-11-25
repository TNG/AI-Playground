import { appLoggerInstance } from '../observability/logger'
import { emitSessionChanged } from '../kernel/kernelBus'
import { updateOverviewSummaryForTurn } from './overviewSummary'
import { readSession, sessionDocumentOf } from './sessions'
import { appendHistoryEntry, updateHistoryEntry, type NewHistoryEntry } from './sessionHistory'
import type {
  HistoryEntry,
  OverviewSummaryUpdate,
  OverviewSummaryRequest,
} from '@/types/sessionIpc'
import type { ChatModelConfig } from '@/types/chatIpc'

const LOG_SCOPE = 'sessions'

/**
 * What a settled turn needs to refresh its Session's Overview Summary: the local
 * model the renderer resolved and the Session's frozen reply language. A cloud
 * turn carries none, because a summary is never written by a cloud model.
 */
export type SummariserDescriptor = {
  readiness?: NonNullable<ChatModelConfig['readiness']>
  replyLanguage: string
}

export type TurnSettlement = {
  /** Absent for a turn with no local model to write an Overview Summary with. */
  summariser?: SummariserDescriptor
  abortSignal?: AbortSignal
}

const BACKEND_OF_SERVICE: Record<string, ChatModelConfig['backend']> = {
  'llamacpp-backend': 'llamaCPP',
  'openvino-backend': 'openVINO',
}

/** The renderer ships readiness only; the summariser needs the full local model config. */
function summaryRequestOf(descriptor?: SummariserDescriptor): OverviewSummaryRequest | null {
  const readiness = descriptor?.readiness
  if (!descriptor || !readiness?.llmModelName) return null
  const backend = BACKEND_OF_SERVICE[readiness.serviceName]
  if (!backend) return null
  return {
    model: { backend, modelId: readiness.llmModelName, readiness },
    language: descriptor.replyLanguage || 'en-US',
  }
}

function patchOf(
  outcome: NonNullable<Awaited<ReturnType<typeof updateOverviewSummaryForTurn>>>,
): OverviewSummaryUpdate | null {
  if (outcome.state === 'ready') {
    return {
      state: 'ready',
      ...(outcome.summary.model ? { model: outcome.summary.model } : {}),
      ...(outcome.summary.writtenAt !== undefined ? { writtenAt: outcome.summary.writtenAt } : {}),
      durationMs: outcome.durationMs,
      ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
      ...(outcome.summary.coveredEntryId ? { coveredEntryId: outcome.summary.coveredEntryId } : {}),
      ...(outcome.summary.text ? { text: outcome.summary.text } : {}),
    }
  }
  return {
    state: 'failed',
    ...(outcome.summary.model ? { model: outcome.summary.model } : {}),
    writtenAt: Date.now(),
    durationMs: outcome.durationMs,
    ...(outcome.tokens !== undefined ? { tokens: outcome.tokens } : {}),
    ...(outcome.summary.coveredEntryId ? { coveredEntryId: outcome.summary.coveredEntryId } : {}),
    ...(outcome.failureReason ? { failureReason: outcome.failureReason } : {}),
  }
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
        ? { ...entry, overviewUpdate: { state: 'pending' } }
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

  let outcome: Awaited<ReturnType<typeof updateOverviewSummaryForTurn>> = null
  try {
    outcome = await updateOverviewSummaryForTurn(
      sessionId,
      summaryRequestOf(options.summariser) ?? {
        language: options.summariser?.replyLanguage ?? 'en-US',
      },
      options.abortSignal,
    )
  } catch (error) {
    appLoggerInstance.warn(`Overview Summary update did not settle the turn: ${error}`, LOG_SCOPE)
  }

  const patch = outcome ? patchOf(outcome) : null
  return patch ? rewriteOutcome(sessionId, written, patch) : written
}
