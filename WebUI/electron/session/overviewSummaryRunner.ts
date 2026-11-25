import { randomUUID } from 'node:crypto'
import { generateText } from 'ai'
import { ensureChatBackendReady } from '../chat/chatReadiness'
import { createMainChatModel } from '../chat/chatModelMain'
import { finishTextRequest, submitTextRequest } from '../kernel/orchestrator'
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
  const { model, prompt, signal, sessionId, final } = input
  if (model.backend === 'cloud' || !model.readiness?.llmModelName) {
    throw new Error('An Overview Summary must be written by a local model')
  }
  const runId = `overview-summary-${randomUUID()}`
  const conversationKey = `overview-summary:${sessionId}`
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
  try {
    await ensureChatBackendReady(model.readiness, {
      skipGpuAdmission: true,
      abortSignal: signal,
      remember: false,
      conversationKey,
      activityLabel: 'Updating Overview Summary…',
    })
    const result = await generateText({
      model: createMainChatModel(model),
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
    finishTextRequest(runId)
  }
}
