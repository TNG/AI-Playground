import { tool } from 'ai'
import { z } from 'zod'
import { useActivities } from '../store/activities'
import { useConversations } from '../store/conversations'
import { useQwen3Tts } from '../store/qwen3Tts'
import { QWEN3_TTS_LANGUAGES, QWEN3_TTS_SPEAKERS } from '@/assets/js/qwen3TtsConstants'
import type { Qwen3TtsLanguage, Qwen3TtsSpeakerId } from '@/assets/js/qwen3TtsConstants'
import { buildTtsAudioFileName, conversationLabelForTtsFile } from '@/lib/ttsAudioFileName'

function conversationKeyFor(experimentalContext: unknown): string {
  const ctx = experimentalContext as { conversationKey?: string } | undefined
  return ctx?.conversationKey ?? useConversations().activeKey
}

const speakerIds = QWEN3_TTS_SPEAKERS.map((s) => s.id) as [string, ...string[]]
const languageIds = QWEN3_TTS_LANGUAGES as [string, ...string[]]

const SynthesizeSpeechOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string(),
  savedFilePath: z.string().optional(),
  speaker: z.string().optional(),
  language: z.string().optional(),
  mode: z.enum(['custom_voice', 'voice_design']).optional(),
})

type SynthesizeSpeechOutput = z.infer<typeof SynthesizeSpeechOutputSchema>

export const synthesizeTextToSpeech = tool({
  description:
    'Synthesize speech from text using Qwen3-TTS and return a WAV audio file. Use this when the user ' +
    'provides a script, narration, podcast segment, or any text they want read aloud. ' +
    'For preset voices (Vivian, Ryan, Serena, etc.) use mode "custom_voice" with `speaker` and optional ' +
    '`instruct` for tone (e.g. "speak cheerfully"). For a fully custom voice described in natural language, ' +
    'use mode "voice_design" with a detailed `instruct` describing timbre, age, accent, and emotion. ' +
    'Set `language` explicitly when known (Chinese, English, Japanese, …) or Auto for detection. ' +
    'When the user asks to change default voice or language for future calls, pass `rememberAsDefault: true`.',
  inputSchema: z.object({
    text: z.string().min(1).describe('The full script or passage to read aloud'),
    language: z
      .enum(languageIds)
      .optional()
      .describe('Target language (Auto lets the model adapt)'),
    speaker: z
      .enum(speakerIds)
      .optional()
      .describe('Preset speaker for custom_voice mode (Ryan, Vivian, Aiden, …)'),
    instruct: z
      .string()
      .optional()
      .describe('Speaking style instructions (tone, emotion, pace) or voice-design description'),
    mode: z
      .enum(['custom_voice', 'voice_design'])
      .optional()
      .describe('custom_voice = named speaker; voice_design = free-form voice from instruct'),
    outputFileName: z
      .string()
      .optional()
      .describe(
        'Optional short label appended to the auto-generated file name (conversation + date)',
      ),
    rememberAsDefault: z
      .boolean()
      .optional()
      .describe('When true, save speaker/language/mode as the user default for later synthesis'),
  }),
  outputSchema: SynthesizeSpeechOutputSchema,
  execute: async (args, options): Promise<SynthesizeSpeechOutput> => {
    const qwen3 = useQwen3Tts()
    const activities = useActivities()
    const conversations = useConversations()
    const conversationKey = conversationKeyFor(options.experimental_context)
    const scope = {
      kind: 'chat' as const,
      conversationKey,
    }

    return activities.track(
      { category: 'tools', label: 'Synthesizing speech…', scope },
      async () => {
        try {
          if (args.rememberAsDefault) {
            await qwen3.applyUserVoicePreference({
              speaker: args.speaker as Qwen3TtsSpeakerId | undefined,
              language: args.language as Qwen3TtsLanguage | undefined,
              mode: args.mode,
            })
          }

          const result = await qwen3.synthesize({
            text: args.text,
            language: args.language as Qwen3TtsLanguage | undefined,
            speaker: args.speaker as Qwen3TtsSpeakerId | undefined,
            instruct: args.instruct,
            mode: args.mode,
          })

          const label = conversationLabelForTtsFile({
            conversationKey,
            messages: conversations.conversationList[conversationKey],
            threadMeta: conversations.getThreadMeta(conversationKey),
          })
          const fileName = buildTtsAudioFileName({
            conversationKey,
            conversationLabel: label,
            userSlug: args.outputFileName,
          })
          const savedFilePath = await qwen3.saveWavToDisk(result.audioBase64, fileName)

          return {
            ok: true,
            message:
              `Synthesized ${result.mode} speech (${result.language}, ${result.speaker}). ` +
              `Saved to ${savedFilePath}. The audio player is shown in the chat.`,
            savedFilePath,
            speaker: result.speaker,
            language: result.language,
            mode: result.mode,
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          return { ok: false, message }
        }
      },
    )
  },
  toModelOutput: ({ output }) => {
    if (!output.ok) {
      return { type: 'error-text', value: output.message }
    }
    return {
      type: 'text',
      value: `${output.message}${output.savedFilePath ? ` File: ${output.savedFilePath}` : ''}`,
    }
  },
})
