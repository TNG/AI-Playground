import { randomUUID } from 'node:crypto'
import type { IpcOk } from '@/types/ipcChannels'
import type { WarmupRequest, WarmupWorkerRequest, WarmupWorkerResult } from '@/types/phisonKmRag'
import { llmServerBaseUrl } from '../adapters/llmServerSnapshot'
import { finishTextRequest, submitTextRequest } from '../kernel/orchestrator'
import { ensureChatBackendReady } from './chatReadiness'
import { appLoggerInstance } from '../observability/logger'

// Phison KM: main's half of one document's KV warmup. The prefill itself runs in the
// langchain worker beside the rest of KM (langchainPhisonKm.ts); this gives it the
// Turn Queue place and a loaded model, so a GPU swap cannot stop the server mid-prefill.

const CONVERSATION_KEY = 'phison-km-warmup'

let active: AbortController | null = null

export async function warmupKmDocument(
  request: WarmupRequest,
  prefill: (request: WarmupWorkerRequest) => Promise<WarmupWorkerResult>,
): Promise<IpcOk> {
  const runId = `${CONVERSATION_KEY}-${randomUUID()}`
  const run = new AbortController()
  active = run
  try {
    await submitTextRequest(
      {
        runId,
        conversationKey: CONVERSATION_KEY,
        needsGpu: Boolean(request.readiness),
        joinsTurnQueue: true,
      },
      run.signal,
    )
    if (request.readiness) {
      await ensureChatBackendReady(request.readiness, { skipGpuAdmission: true })
    }
    if (run.signal.aborted) throw new Error('Warmup cancelled')
    const llmBackendUrl = llmServerBaseUrl('llamaCPP')
    if (!llmBackendUrl) throw new Error('The llama.cpp LLM server is not running')
    const { readiness: _readiness, ...workerRequest } = request
    const result = await prefill({ ...workerRequest, llmBackendUrl })
    if (!result.success) throw new Error(result.error)
    return { success: true }
  } finally {
    if (active === run) active = null
    finishTextRequest(runId)
  }
}

/** Stops the warmup in flight, queued or prefilling, so the question behind it need not wait. */
export async function cancelKmDocumentWarmup(abortPrefill: () => Promise<unknown>): Promise<IpcOk> {
  if (!active) return { success: true }
  active.abort()
  try {
    await abortPrefill()
  } catch (error) {
    appLoggerInstance.warn(`Phison KM: could not abort the warmup: ${error}`, 'phison-km')
  }
  return { success: true }
}
