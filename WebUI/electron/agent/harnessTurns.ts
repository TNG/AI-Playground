import fs from 'node:fs'
import type { AgentSession, SessionEntry, SessionManager } from '@earendil-works/pi-coding-agent'
import { loadPi } from './piRuntime.ts'
import { piSessionDir, readSessionStore } from './piSessionStore.ts'
import { active, agentTurns } from './piAgentState.ts'
import { removeTimelineMessages } from '../session/sessionTimeline.ts'
import { HARNESS_TURN_REFUSALS, type DeleteAgentTurnsRequest } from '@/types/agentIpc'

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

/** Deletes turns from a Harness Session and their messages from the Session's timeline. */
export async function deleteAgentTurns(request: DeleteAgentTurnsRequest): Promise<void> {
  const { harnessSessionId, sessionRef } = request
  if (agentTurns.has(harnessSessionId)) throw new Error(HARNESS_TURN_REFUSALS.running)
  const turnIds = new Set(request.turnIds)
  if (turnIds.size > 0) {
    if (active?.sessionId === harnessSessionId) {
      if (omitHarnessTurns(active.session.sessionManager, turnIds)) {
        active.session.refreshContext()
      }
    } else {
      const file = readSessionStore()[harnessSessionId]?.sessionFilePath
      if (file && fs.existsSync(file)) {
        const pi = await loadPi()
        omitHarnessTurns(pi.SessionManager.open(file, piSessionDir()), turnIds)
      }
    }
  }
  if (sessionRef && request.messageIds.length > 0) {
    await removeTimelineMessages(sessionRef, request.messageIds)
  }
}
