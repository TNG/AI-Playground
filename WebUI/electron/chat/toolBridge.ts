import { randomUUID } from 'node:crypto'
import { getKernelEventWindow } from '../kernel/kernelBus'
import type { ChatToolExecution, ChatToolResult } from '@/types/chatIpc'

/**
 * Main → renderer request/response seam for chat tool execution (step 6).
 * Tool closures live renderer-side (they read Pinia: workflow catalogs, speech
 * engines, MCP state), so main's turn engine calls them back over one channel
 * and waits for the reply by requestId — the same trust direction as
 * `agentMode:executeTool`. A cancelled turn rejects its pending calls so the
 * engine's stream aborts promptly; a replaced window settles everything.
 */
const TOOL_REQUEST_CHANNEL = 'chat:executeTool'

/** Rejected with this marker when the owning turn was aborted. */
export const CHAT_TOOL_ABORTED = 'AIPG_CHAT_TOOL_ABORTED'

/**
 * Aborted as an `AbortError` so the AI SDK treats the failed tool call as an
 * abort (finishReason 'abort') rather than a tool failure, mirroring what the
 * renderer-side abortSignal did before the move.
 */
function abortError(): Error {
  const error = new Error(CHAT_TOOL_ABORTED)
  error.name = 'AbortError'
  return error
}

const DEFAULT_TOOL_BRIDGE_TIMEOUT_MS = 10 * 60 * 1000

let toolBridgeTimeoutMs = DEFAULT_TOOL_BRIDGE_TIMEOUT_MS

type PendingToolRequest = {
  requestId: string
  turnId: string
  toolName: string
  timer: ReturnType<typeof setTimeout>
  resolve: (result: unknown) => void
  reject: (error: Error) => void
}

const pending = new Map<string, PendingToolRequest>()

function dropPending(requestId: string): PendingToolRequest | undefined {
  const entry = pending.get(requestId)
  if (!entry) return undefined
  pending.delete(requestId)
  clearTimeout(entry.timer)
  return entry
}

export function executeToolInRenderer<T>(
  payload: Omit<ChatToolExecution, 'requestId'>,
): Promise<T> {
  const win = getKernelEventWindow()
  if (!win || win.isDestroyed()) {
    return Promise.reject(new Error('No renderer window available for the tool call'))
  }
  const requestId = randomUUID()
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const timedOut = dropPending(requestId)
      if (!timedOut) return
      timedOut.reject(
        new Error(`Renderer tool '${payload.toolName}' timed out after ${toolBridgeTimeoutMs}ms`),
      )
    }, toolBridgeTimeoutMs)
    pending.set(requestId, {
      requestId,
      turnId: payload.turnId,
      toolName: payload.toolName,
      timer,
      resolve: resolve as (result: unknown) => void,
      reject,
    })
    try {
      win.webContents.send(TOOL_REQUEST_CHANNEL, { ...payload, requestId })
    } catch (error) {
      dropPending(requestId)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}

/** Wired to the `chat:toolResult` IPC channel in main. */
export function handleChatToolResult(payload: ChatToolResult): void {
  if (typeof payload?.requestId !== 'string') return
  const entry = dropPending(payload.requestId)
  if (!entry) return
  if (payload.aborted) {
    entry.reject(abortError())
  } else if (payload.error !== undefined) {
    entry.reject(new Error(payload.error))
  } else {
    entry.resolve(payload.output)
  }
}

/** Reject a cancelled turn's pending calls so the engine can abort its stream. */
export function abortTurnToolRequests(turnId: string): void {
  for (const entry of [...pending.values()]) {
    if (entry.turnId !== turnId) continue
    dropPending(entry.requestId)
    entry.reject(abortError())
  }
}

/** Main calls this when the kernel window changes: the asked renderer is gone. */
export function rejectAllChatToolRequests(reason: string): void {
  for (const entry of [...pending.values()]) {
    dropPending(entry.requestId)
    entry.reject(new Error(reason))
  }
}

export function setChatToolBridgeTimeoutMsForTest(ms: number): void {
  toolBridgeTimeoutMs = ms
}

// Test seam.
export function resetChatToolBridgeForTest(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
  toolBridgeTimeoutMs = DEFAULT_TOOL_BRIDGE_TIMEOUT_MS
}

export function chatToolRequestsPending(): number {
  return pending.size
}
