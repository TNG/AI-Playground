import { generateText } from 'ai'
import { ChatSummarizeRequestSchema, type ChatSummarizeRequest } from '@/types/chatIpc'
import { createMainChatModel } from './chatModelMain'

// ── One-shot conversation summarization (step 6: chat inference in main) ────
//
// Title generation for conversations ran through the renderer's shared model
// factory before the move; the model call now has to come from main, so the
// store ships the same prompt plus a ChatModelConfig over `chat:summarize`.
// Caller contract is unchanged: the caller ensures backend readiness first.

const SUMMARY_PROMPT_PREFIX =
  'Summarize this conversation in 5 words or less. ' +
  'Output only the summary, no quotes, no punctuation.\n\n'

export async function summarizeConversationText(request: unknown): Promise<string> {
  const req = ChatSummarizeRequestSchema.parse(request) as ChatSummarizeRequest
  const { text } = await generateText({
    model: createMainChatModel(req.model),
    prompt: `${SUMMARY_PROMPT_PREFIX}${req.messagesText}`,
    maxOutputTokens: 24,
  })
  return text.trim().split(/\s+/).slice(0, 5).join(' ')
}
