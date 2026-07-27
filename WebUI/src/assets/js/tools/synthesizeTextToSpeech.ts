import { tool } from 'ai'
import { z } from 'zod'
import { useActivities } from '../store/activities'
import { useConversations } from '../store/conversations'
import { useQwen3TextToSpeech } from '../store/qwen3TextToSpeech'
import { QWEN3_TTS_LANGUAGES, QWEN3_TTS_SPEAKERS } from '@/assets/js/qwen3TtsConstants'
import type { Qwen3TtsLanguage, Qwen3TtsSpeakerId } from '@/assets/js/qwen3TtsConstants'
import { buildTtsAudioFileName, conversationLabelForTtsFile } from '@/lib/ttsAudioFileName'
import { ToolConversationContextSchema, conversationKeyFor } from './toolContext'

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
    'Text-to-speech (TTS): speak `text` aloud and save a playable WAV file. Call this whenever ' +
    'the user wants text read/said out loud, narrated, voiced, or turned into audio — do not just ' +
    'reply with the text. Voice: mode "custom_voice" + `speaker` (Vivian, Ryan, Serena, …), or ' +
    'mode "voice_design" + a natural-language `instruct` (timbre, age, accent, emotion); `instruct` ' +
    'also sets tone. `language`: a known value or Auto. `rememberAsDefault: true` saves the voice/language default.',
  inputSchema: z.object({
    text: z.string().min(1).describe('The exact words to speak aloud (the full script or passage)'),
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
  contextSchema: ToolConversationContextSchema,
  execute: async (args, options): Promise<SynthesizeSpeechOutput> => {
    const qwen3 = useQwen3TextToSpeech()
    const activities = useActivities()
    const conversations = useConversations()
    const conversationKey = conversationKeyFor(options.context)
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
