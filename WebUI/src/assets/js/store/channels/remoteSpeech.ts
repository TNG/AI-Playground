import { markdownToSpeechText } from '@/lib/markdownToSpeech'
import type { ChannelAdapter } from './adapter'
import type { InboundMeta, RemoteAudio } from './types'

const NO_SPEECH_TO_TEXT =
  '⚠️ Voice not transcribed: a speech-to-text backend must be installed in AI Playground on the desktop.'
const SPEECH_MODEL_DECLINED =
  'Voice not transcribed: speech model not downloaded. Send text instead.'

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
  transcriptionModel: {
    /** A transcription backend is installed, or a fallback endpoint is configured. */
    installed: () => boolean
    /** The selected engine's model files not yet on disk. */
    missing: () => Promise<DownloadModelParam[]>
    /** Asks the remote sender (unless pre-granted) and downloads; false when declined. */
    download: (models: DownloadModelParam[]) => Promise<boolean>
  }
  synthesisModel: {
    /** The selected engine is installed but its model is not on disk. */
    missing: () => Promise<boolean>
    /** Asks the sender in-channel (desktop mirror, pre-grant honored) and downloads; false when declined. */
    install: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<boolean>
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
}

const failureText = (e: unknown) =>
  `⚠️ Could not transcribe the audio: ${e instanceof Error ? e.message : String(e)}`

export function createRemoteSpeech(deps: RemoteSpeechDeps): RemoteSpeech {
  async function transcribe(
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ): Promise<string | null> {
    const say = (message: string) => adapter.reply(adapter.formatRichSnippet(message), meta)
    if (!deps.transcriptionModel.installed()) {
      await say(NO_SPEECH_TO_TEXT)
      return null
    }
    try {
      const missing = await deps.transcriptionModel.missing()
      if (missing.length > 0 && !(await deps.transcriptionModel.download(missing))) {
        await say(SPEECH_MODEL_DECLINED)
        return null
      }
    } catch (e) {
      deps.log('homeAgent: speech model download failed', e)
      await say(failureText(e))
      return null
    }
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
      const message = deps.transcription.isNoEndpoint(e) ? NO_SPEECH_TO_TEXT : failureText(e)
      await say(message)
      return null
    } finally {
      stopTyping()
    }
  }

  async function speak(adapter: ChannelAdapter, text: string, meta?: InboundMeta): Promise<void> {
    const spoken = markdownToSpeechText(text ?? '').trim()
    if (!spoken || !deps.synthesis.allowed()) return
    try {
      let clip = await deps.synthesis.synthesize(spoken)
      if (!clip && (await installMissingModel(adapter, meta))) {
        clip = await deps.synthesis.synthesize(spoken)
      }
      if (!clip) return
      await adapter.voice(clip.audioBase64, clip.mediaType, meta)
    } catch (e) {
      deps.log('homeAgent: voice reply failed', e)
    }
  }

  async function installMissingModel(adapter: ChannelAdapter, meta?: InboundMeta) {
    return (await deps.synthesisModel.missing()) && deps.synthesisModel.install(adapter, meta)
  }

  return { transcribe, speak }
}
