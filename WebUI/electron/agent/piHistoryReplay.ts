import type { SessionManager } from '@earendil-works/pi-coding-agent'
import { readHistoryEntries } from '../session/sessionHistory.ts'
import { historyAsSeenFrom } from '../session/sessionUpdate.ts'
import type { HistoryEntry } from '@/types/sessionIpc'

type AssistantMessage = Extract<
  Parameters<SessionManager['appendMessage']>[0],
  { role: 'assistant' }
>

type ReplayTarget = {
  sessionRef: string
  presetName: string
  workspaceDir: string
  model: { api: AssistantMessage['api']; provider: AssistantMessage['provider']; id: string }
}

/** A turn this preset ran on the chat turn engine, which no Harness Session has seen. */
function isChatEngineTurn(entry: HistoryEntry, presetName: string): boolean {
  return (
    entry.kind === 'chat' &&
    entry.preset === presetName &&
    !entry.taskName &&
    !entry.agentId &&
    !!entry.prompt.trim() &&
    (!!entry.response?.trim() || entry.artifacts.length > 0)
  )
}

function replyText(entry: HistoryEntry): string {
  const files = entry.artifacts.map((artifact) => artifact.path)
  return [entry.response?.trim() ?? '', files.length > 0 ? `Files: ${files.join(', ')}` : '']
    .filter((part) => part !== '')
    .join('\n\n')
}

/**
 * Seeds a new Harness Session with the preset's earlier chat-engine turns as real messages,
 * written to its Pi file so they stay the same prefix on every later request. Returns the
 * replayed History Entry ids, which the Session Update must then leave out.
 */
export async function replayChatEngineTurns(
  sessionManager: SessionManager,
  target: ReplayTarget,
): Promise<string[]> {
  const entries = (await readHistoryEntries(target.sessionRef)).filter((entry) =>
    isChatEngineTurn(entry, target.presetName),
  )
  if (entries.length === 0) return []
  const seen = await historyAsSeenFrom(target.sessionRef, entries, target.workspaceDir)
  for (const entry of seen) {
    sessionManager.appendMessage({
      role: 'user',
      content: entry.prompt,
      timestamp: entry.timestamp,
    })
    sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: replyText(entry) }],
      api: target.model.api,
      provider: target.model.provider,
      model: target.model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: entry.timestamp,
    })
  }
  return entries.map((entry) => entry.id)
}
