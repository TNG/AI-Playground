import { tool, type FilePart, type ModelMessage } from 'ai'
import { z } from 'zod'
import { useActivities } from '../store/activities'
import { useConversations } from '../store/conversations'
import { useSpeechToText } from '../store/speechToText'
import { transcribeAudioBlob } from '@/lib/transcribe'

function conversationKeyFor(experimentalContext: unknown): string {
  const ctx = experimentalContext as { conversationKey?: string } | undefined
  return ctx?.conversationKey ?? useConversations().activeKey
}

/** Resolve a FilePart's data (data URL, blob/http URL, or URL object) to a Blob. */
async function filePartToBlob(data: FilePart['data']): Promise<Blob> {
  const url = typeof data === 'string' ? data : data instanceof URL ? data.href : null
  if (!url) {
    throw new Error('Unsupported audio data (expected a data URL or URL).')
  }
  const response = await fetch(url)
  return await response.blob()
}

const TranscribeAudioOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  transcript: z.string().optional(),
})

type TranscribeAudioOutput = z.infer<typeof TranscribeAudioOutputSchema>

export const transcribeAudio = tool({
  description:
    'Speech-to-text (STT): transcribe the most recent audio attachment in the conversation into ' +
    'text using the local Whisper model. Call this whenever the user attaches a voice message or ' +
    'audio file and wants it transcribed, or refers to "what was said" in an audio clip.',
  inputSchema: z.object({
    // No inputs: the audio is taken from the latest audio attachment in the chat.
    // A required-but-empty object keeps the schema valid across providers.
  }),
  outputSchema: TranscribeAudioOutputSchema,
  execute: async (_args, options): Promise<TranscribeAudioOutput> => {
    const activities = useActivities()
    const speechToText = useSpeechToText()
    const conversationKey = conversationKeyFor(options.experimental_context)
    const messages = (options.messages ?? []) as ModelMessage[]

    const activityId = activities.begin({
      category: 'tools',
      label: 'Transcribing audio…',
      scope: { kind: 'chat', conversationKey },
    })
    try {
      // Find the most recent audio attachment in any user message.
      const audioPart = messages
        .filter((msg) => msg.role === 'user' && Array.isArray(msg.content))
        .flatMap((msg) => msg.content as Array<{ type: string; mediaType?: string }>)
        .findLast(
          (part): part is FilePart =>
            part.type === 'file' && part.mediaType?.startsWith('audio/') === true,
        )

      if (!audioPart?.data) {
        throw new Error('No audio attachment found in the conversation to transcribe.')
      }

      if (speechToText.selectedSttEngine !== 'external') {
        await speechToText.ensureWhisperReady()
      }
      const endpoint = await speechToText.resolveTranscription()
      if (!endpoint) {
        throw new Error('Speech To Text is not available (no OVMS server or fallback configured).')
      }

      const blob = await filePartToBlob(audioPart.data)
      const transcript = await transcribeAudioBlob(blob, endpoint)

      activities.end(activityId, 'done')
      return { ok: true, message: 'Transcribed audio.', transcript }
    } catch (error) {
      activities.end(activityId, 'failed')
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  },
  toModelOutput: ({ output }) => {
    if (!output.ok) {
      return { type: 'error-text', value: output.message }
    }
    return { type: 'text', value: output.transcript ?? output.message }
  },
})
