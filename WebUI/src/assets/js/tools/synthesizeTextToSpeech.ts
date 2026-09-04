import { tool } from 'ai'
import { z } from 'zod'
import { useActivities } from '../store/activities'
import { useConversations } from '../store/conversations'
import {
  saveSpeechClip,
  synthesizeClip,
  type SpeechClipResult,
} from '../speech/speechIO'
import { QWEN3_TTS_LANGUAGES, QWEN3_TTS_SPEAKERS } from '@/assets/js/qwen3TtsConstants'
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
  // Reports the mode that actually ran, which includes `voice_clone`: a saved voice
  // is reproduced by cloning its preview, chosen by the store rather than the caller.
  mode: z.enum(['custom_voice', 'voice_design', 'voice_clone']).optional(),
})

type SynthesizeSpeechOutput = z.infer<typeof SynthesizeSpeechOutputSchema>

function resultMessage(clip: SpeechClipResult, savedFilePath: string): string {
  const detail =
    clip.engine === 'qwen3'
      ? `Synthesized ${clip.mode} speech (${clip.language}, ${clip.voice}).`
      : `Synthesized speech with ${clip.engine === 'kokoro' ? 'Kokoro' : 'the external endpoint'} (${clip.voice}).`
  return `${detail} Saved to ${savedFilePath}. The audio player is shown in the chat.`
}

export const synthesizeTextToSpeech = tool({
  description:
    'Text-to-speech (TTS): speak `text` aloud and save a playable WAV file. Call this whenever ' +
    'the user wants text read/said out loud, narrated, voiced, or turned into audio — do not just ' +
    "reply with the text. Voice: a saved voice by name via `voiceName` (the user's named voices, " +
    'e.g. "read this in Tammy\'s voice"), or mode "custom_voice" + `speaker` (Vivian, Ryan, Serena, …), ' +
    'or mode "voice_design" + a natural-language `instruct` (timbre, age, accent, emotion); `instruct` ' +
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
    voiceName: z
      .string()
      .optional()
      .describe(
        "Name of one of the user's saved voices (case-insensitive). Overrides speaker/mode/instruct " +
          'with that saved voice description. Use when the user refers to a voice by name.',
      ),
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
    const activities = useActivities()
    const conversations = useConversations()
    const conversationKey = conversationKeyFor(options.context)
    const scope = {
      kind: 'chat' as const,
      conversationKey,
    }

    // Two visible phases: loading the model (slow on the first call / may prompt
    // the install popup) then generating the audio file. The engine fires its
    // phase signal before its first await, so the activity's initial label is
    // replaced before it ever renders. The activity is always ended (even on
    // throw).
    const activityId = activities.begin({
      category: 'tools',
      label: 'Loading voice model…',
      scope,
    })
    try {
      const clip = await synthesizeClip({
        text: args.text,
        voice: {
          speaker: args.speaker,
          language: args.language,
          mode: args.mode,
          instruct: args.instruct,
          voiceName: args.voiceName,
          rememberAsDefault: args.rememberAsDefault,
        },
        onPhase: (phase) =>
          activities.update(activityId, {
            label: phase === 'loading-model' ? 'Loading voice model…' : 'Generating audio file…',
          }),
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
      const savedFilePath = await saveSpeechClip(clip.audioBase64, fileName)

      activities.end(activityId, 'done')
      return {
        ok: true,
        message: resultMessage(clip, savedFilePath),
        savedFilePath,
        speaker: clip.voice,
        ...(clip.engine === 'qwen3'
          ? { language: clip.language, mode: clip.mode }
          : {}),
      }
    } catch (error) {
      activities.end(activityId, 'failed')
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, message }
    }
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
