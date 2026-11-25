import { randomUUID } from 'node:crypto'
import { generateText } from 'ai'
import { ensureChatBackendReady } from '../chat/chatReadiness'
import { createMainChatModel } from '../chat/chatModelMain'
import { finishTextRequest, submitTextRequest } from '../kernel/orchestrator'
import { isLocalSummaryModel, summaryModelConfig } from '@/lib/summariser'
import {
  parseOverviewSummaryReply,
  type OverviewSummaryCompleteInput,
  type OverviewSummaryCompletion,
} from './overviewSummary'

// The real model behind an Overview Summary update: the renderer-resolved local
// model, loaded and admitted through the same Turn Queue as a chat turn. It is
// never cloud work; the service refuses a cloud model before reaching here.

export async function runOverviewSummaryCompletion(
  input: OverviewSummaryCompleteInput,
): Promise<OverviewSummaryCompletion> {
  const { model, prompt, signal, sessionId, final, admitted } = input
  const readiness = model.readiness
  if (!isLocalSummaryModel(model) || !readiness) {
    throw new Error('An Overview Summary must be written by a local model')
  }
  const runId = `overview-summary-${randomUUID()}`
  const conversationKey = `overview-summary:${sessionId}`
  // A panel media run settled while still holding the Turn Queue's place; it
  // enters its own admission here instead of taking a second place.
  if (!admitted) {
    await submitTextRequest(
      {
        runId,
        conversationKey,
        needsGpu: true,
        joinsTurnQueue: true,
        work: 'summary',
      },
      signal,
    )
  }
  try {
    await ensureChatBackendReady(readiness, {
      skipGpuAdmission: true,
      abortSignal: signal,
      remember: false,
      conversationKey,
      activityLabel: 'Updating Overview Summary…',
    })
    const result = await generateText({
      model: createMainChatModel(summaryModelConfig(model)),
      prompt,
      abortSignal: signal,
      temperature: 0.2,
    })
    const usage = result.usage
    const tokens = usage ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : undefined
    return {
      ...parseOverviewSummaryReply(result.text, final),
      ...(tokens !== undefined ? { tokens } : {}),
    }
  } finally {
    if (!admitted) finishTextRequest(runId)
  }
}
