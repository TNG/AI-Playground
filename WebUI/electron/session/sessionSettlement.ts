import { appLoggerInstance } from '../observability/logger'
import { appendHistoryEntry, type NewHistoryEntry } from './sessionHistory'
import type { HistoryEntry } from '@/types/sessionIpc'
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

/**
 * The one seam every turn kind settles through: its History Entry is appended
 * before the turn reports done, and a failed append is logged without failing
 * the turn. The summariser and abort signal are accepted for the Overview
 * Summary update, which does not run yet.
 */
export async function settleTurn(
  sessionId: string,
  entry: NewHistoryEntry,
  _options: TurnSettlement = {},
): Promise<HistoryEntry | undefined> {
  try {
    return await appendHistoryEntry(sessionId, entry)
  } catch (error) {
    appLoggerInstance.warn(`turn not recorded in its Session: ${error}`, LOG_SCOPE)
    return undefined
  }
}
