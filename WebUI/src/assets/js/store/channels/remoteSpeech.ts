import { markdownToSpeechText } from '@/lib/markdownToSpeech'
import type { ChannelAdapter } from './adapter'
import type { InboundMeta, RemoteAudio } from './types'

const NO_SPEECH_TO_TEXT =
  '⚠️ No speech-to-text is available. Install the OpenVINO backend or the standalone Whisper backend, or configure a fallback transcription endpoint in the Speech to Text preset settings.'

const VOICE_DECLINED = 'Voice not transcribed: speech model not downloaded. Send text instead.'
const NO_STT_BACKEND =
  '⚠️ Voice not transcribed: install a speech-to-text backend in AI Playground on the desktop.'

export type RemoteSpeechDeps = {
  transcription: {
    /** Starts the selected engine when it is installed and its model is on disk; never asks. */
    ready: () => Promise<void>
    transcribe: (audio: RemoteAudio) => Promise<string>
    /** The failure means no speech-to-text endpoint exists at all. */
    isNoEndpoint: (error: unknown) => boolean
  }
  synthesis: {
    /** Spoken replies are on for the Home Agent preset. */
    allowed: () => boolean
    /** Null when the engine or its model is missing; never asks. */
    synthesize: (text: string) => Promise<{ audioBase64: string; mediaType: string } | null>
  }
  /** Speech-to-text for a voice Answer, whose download is asked by the answered agent session. */
  answerTranscription?: {
    /** What the selected engine still needs; 'no-backend' when none is installed or configured. */
    missing: () => Promise<DownloadModelParam[] | 'no-backend'>
    /** The session's download question, mirrored on the desktop; rejects when declined or failed. */
    download: (models: DownloadModelParam[], sessionId: string) => Promise<void>
    isDeclined: (error: unknown) => boolean
  }
  log: (message: string, error: unknown) => void
}

/** Speech for a channel sender: their voice messages in, spoken replies out. */
export type RemoteSpeech = {
  /** The joined transcript, or null when it failed and the channel was already told why. */
  transcribe: (
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ) => Promise<string | null>
  /** Sends `text` as a voice message too; best-effort, the text reply already went out. */
  speak: (adapter: ChannelAdapter, text: string, meta?: InboundMeta) => Promise<void>
  /** Downloads a missing speech model for a voice Answer to `sessionId`; false once the channel was told why not. */
  prepareAnswer: (
    adapter: ChannelAdapter,
    sessionId: string,
    meta?: InboundMeta,
  ) => Promise<boolean>
}

export function createRemoteSpeech(deps: RemoteSpeechDeps): RemoteSpeech {
  async function transcribe(
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ): Promise<string | null> {
    await deps.transcription.ready()
    const stopTyping = adapter.startTypingHeartbeat('typing', meta)
    try {
      const parts: string[] = []
      for (const clip of audio) {
        const text = await deps.transcription.transcribe(clip)
        if (text) parts.push(text.trim())
      }
      return parts.filter(Boolean).join(' ').trim()
    } catch (e) {
      deps.log('homeAgent: audio transcription failed', e)
      const message = deps.transcription.isNoEndpoint(e)
        ? NO_SPEECH_TO_TEXT
        : `⚠️ Could not transcribe the audio: ${e instanceof Error ? e.message : String(e)}`
      await adapter.reply(adapter.formatRichSnippet(message), meta)
      return null
    } finally {
      stopTyping()
    }
  }

  async function speak(adapter: ChannelAdapter, text: string, meta?: InboundMeta): Promise<void> {
    const spoken = markdownToSpeechText(text ?? '').trim()
    if (!spoken || !deps.synthesis.allowed()) return
    try {
      const clip = await deps.synthesis.synthesize(spoken)
      if (!clip) return
      await adapter.voice(clip.audioBase64, clip.mediaType, meta)
    } catch (e) {
      deps.log('homeAgent: voice reply failed', e)
    }
  }

  async function prepareAnswer(
    adapter: ChannelAdapter,
    sessionId: string,
    meta?: InboundMeta,
  ): Promise<boolean> {
    const answerTranscription = deps.answerTranscription
    if (!answerTranscription) return true
    const missing = await answerTranscription.missing()
    if (missing === 'no-backend') {
      await adapter.post(adapter.formatMarkdown(NO_STT_BACKEND), meta)
      return false
    }
    if (missing.length === 0) return true
    try {
      await answerTranscription.download(missing, sessionId)
      return true
    } catch (e) {
      const declined = answerTranscription.isDeclined(e)
      if (!declined) deps.log('homeAgent: speech model download failed', e)
      const message = declined
        ? VOICE_DECLINED
        : `⚠️ Could not download the speech model: ${e instanceof Error ? e.message : String(e)}`
      await adapter.post(adapter.formatMarkdown(message), meta)
      return false
    }
  }

  return { transcribe, speak, prepareAnswer }
}
