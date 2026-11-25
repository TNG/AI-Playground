import fs from 'node:fs'
import type { AgentSession, SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import { loadPi } from './piRuntime.ts'
import { piSessionDir, readSessionStore } from './piSessionStore.ts'
import { active, agentTurns } from './piAgentState.ts'
import { removeTimelineMessages } from '../session/sessionTimeline.ts'
import { removeHistoryEntries } from '../session/sessionHistory.ts'
import { deleteTurnJournal, restoreTurnJournal, turnJournalHostShell } from './workspaceJournal.ts'
import { appLoggerInstance } from '../observability/logger.ts'
import { HARNESS_TURN_REFUSALS, type DeleteAgentTurnsRequest } from '@/types/agentIpc'

const logger = appLoggerInstance
const LOG_SOURCE = 'harnessTurns'

/** Opens each turn in the Harness Session; it is not model context, so the KV cache is kept. */
export const HARNESS_TURN_ENTRY = 'aipg-turn'

export function markHarnessTurn(session: AgentSession, turnId: string): void {
  session.sessionManager.appendCustomEntry(HARNESS_TURN_ENTRY, { turnId })
}

function turnMarkerId(entry: SessionEntry): string | undefined {
  if (entry.type !== 'custom' || entry.customType !== HARNESS_TURN_ENTRY) return undefined
  const turnId = (entry.data as { turnId?: unknown } | undefined)?.turnId
  return typeof turnId === 'string' ? turnId : ''
}

function reachesModel(entry: SessionEntry): boolean {
  if (entry.type === 'custom_message') return true
  return (
    entry.type === 'message' &&
    (entry.message.role === 'user' ||
      entry.message.role === 'assistant' ||
      entry.message.role === 'toolResult')
  )
}

/** Pi entries are append-only, so a turn is dropped with one context edit per entry. */
function omitHarnessTurns(manager: SessionManager, turnIds: ReadonlySet<string>): boolean {
  let inTurn = false
  const omit: string[] = []
  for (const entry of manager.getBranch()) {
    const marker = turnMarkerId(entry)
    if (marker !== undefined) inTurn = turnIds.has(marker)
    else if (inTurn && reachesModel(entry)) omit.push(entry.id)
  }
  for (const id of omit) manager.appendContextEdit(id, null)
  return omit.length > 0
}

/** The turn markers of a branch, in the order the turns ran. */
function harnessTurnMarkers(manager: SessionManager): string[] {
  return manager.getBranch().flatMap((entry) => {
    const marker = turnMarkerId(entry)
    return marker === undefined || marker === '' ? [] : [marker]
  })
}

/**
 * Delete joins Regenerate and Edit on the trailing turns only: rolling back an
 * earlier one would put the workspace back under the work built on top of it.
 * The requested turns must therefore be the session's newest; they come back
 * here in the order they ran.
 */
function trailingTurns(markers: string[], turnIds: ReadonlySet<string>): string[] {
  const trailing = markers.slice(-turnIds.size)
  if (trailing.length !== turnIds.size || trailing.some((id) => !turnIds.has(id))) {
    throw new Error(HARNESS_TURN_REFUSALS.notLatest)
  }
  return trailing
}

/** A turn that ran with the host shell cannot be rolled back, so deleting it is refused. */
function assertTurnsNotHostShell(sessionId: string, turnIds: ReadonlySet<string>): void {
  for (const turnId of turnIds) {
    if (turnJournalHostShell(sessionId, turnId)) throw new Error(HARNESS_TURN_REFUSALS.hostShell)
  }
}

type PromptImages = NonNullable<NonNullable<Parameters<AgentSession['prompt']>[1]>['images']>

/** The user message a rewound turn opened with, exactly as the model was sent it. */
export type RewoundPrompt = { text: string; images: PromptImages }

/** Moves the leaf to just before the latest turn, leaving the history ahead untouched. */
export function rewindHarnessTurn(session: AgentSession, turnId: string): RewoundPrompt {
  const branch = session.sessionManager.getBranch()
  const markers = branch.flatMap((entry, index) =>
    turnMarkerId(entry) === undefined ? [] : [index],
  )
  const at = markers.at(-1)
  if (at === undefined || turnMarkerId(branch[at]) !== turnId) {
    throw new Error(HARNESS_TURN_REFUSALS.notLatest)
  }
  const opening = branch
    .slice(at + 1)
    .find((entry) => entry.type === 'message' && entry.message.role === 'user')
  if (opening?.type !== 'message' || opening.message.role !== 'user') {
    throw new Error(HARNESS_TURN_REFUSALS.noPrompt)
  }
  const { content } = opening.message
  const parts = typeof content === 'string' ? [{ type: 'text' as const, text: content }] : content
  const text = parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('')
  const images = parts.filter((part) => part.type === 'image')
  const parentId = branch[at].parentId
  if (parentId) session.sessionManager.branch(parentId)
  else session.sessionManager.resetLeaf()
  session.refreshContext()
  return { text, images }
}

/** How a delete left the workspace behind: paths that could not be put back. */
export type DeleteAgentTurnsResult = { unrestorable: string[] }

/** Deletes turns from a Harness Session and their messages from the Session's timeline. */
export async function deleteAgentTurns(
  request: DeleteAgentTurnsRequest,
): Promise<DeleteAgentTurnsResult> {
  const { harnessSessionId, sessionRef } = request
  if (agentTurns.has(harnessSessionId)) throw new Error(HARNESS_TURN_REFUSALS.running)
  const turnIds = new Set(request.turnIds)
  const unrestorable: string[] = []
  if (turnIds.size > 0) {
    let trailing: string[] = []
    if (active?.sessionId === harnessSessionId) {
      const manager = active.session.sessionManager
      trailing = trailingTurns(harnessTurnMarkers(manager), turnIds)
      assertTurnsNotHostShell(harnessSessionId, turnIds)
      if (omitHarnessTurns(manager, turnIds)) {
        active.session.refreshContext()
      }
    } else {
      const file = readSessionStore()[harnessSessionId]?.sessionFilePath
      if (file && fs.existsSync(file)) {
        const pi = await loadPi()
        const manager = pi.SessionManager.open(file, piSessionDir())
        trailing = trailingTurns(harnessTurnMarkers(manager), turnIds)
        assertTurnsNotHostShell(harnessSessionId, turnIds)
        omitHarnessTurns(manager, turnIds)
      }
    }
    // The workspace goes back as the deleted turns found it, newest first, so
    // each restore undoes the turn that ran on top of it.
    for (const turnId of [...trailing].reverse()) {
      const report = await restoreTurnJournal(harnessSessionId, turnId)
      if (report?.unrestorable.length) {
        unrestorable.push(...report.unrestorable)
        logger.warn(
          `journal restore of ${turnId} could not put back: ${report.unrestorable.join(', ')}`,
          LOG_SOURCE,
        )
      }
      deleteTurnJournal(harnessSessionId, turnId)
    }
  }
  if (sessionRef) {
    if (turnIds.size > 0) await removeHistoryEntries(sessionRef, harnessSessionId, turnIds)
    if (request.messageIds.length > 0) {
      await removeTimelineMessages(sessionRef, request.messageIds)
    }
  }
  return { unrestorable }
}
