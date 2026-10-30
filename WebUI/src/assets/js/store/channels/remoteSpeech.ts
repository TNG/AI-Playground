import { answerRouterCopy } from '@/lib/answerRouterWording'
import { markdownToSpeechText } from '@/lib/markdownToSpeech'
import { fillTemplate } from '@/lib/notificationLabel'
import type { ChannelAdapter } from './adapter'
import type { VoiceAnswerPreparation } from './answerRouter'
import type { InboundMeta, RemoteAudio } from './types'

export type RemoteSpeechDeps = {
  transcription: {
    /** Never asks: starts the engine only when it and its model are already there. */
    ready: () => Promise<void>
    transcribe: (audio: RemoteAudio) => Promise<string>
    isNoEndpoint: (error: unknown) => boolean
  }
  synthesis: {
    allowed: () => boolean
    /** Null when the engine or its model is missing; never asks. */
    synthesize: (text: string) => Promise<{ audioBase64: string; mediaType: string } | null>
  }
  transcriptionModel: {
    /** True for a configured fallback endpoint too. */
    installed: () => boolean
    missing: () => Promise<DownloadModelParam[]>
    /** False when declined. */
    download: (models: DownloadModelParam[]) => Promise<boolean>
  }
  synthesisModel: {
    missing: () => Promise<boolean>
    /** False when declined. */
    install: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<boolean>
  }
  /** Asked as the answered agent session's download; false when declined. */
  answerDownload: (models: DownloadModelParam[], sessionId: string) => Promise<boolean>
  log: (message: string, error: unknown) => void
}

export type RemoteSpeech = {
  /** Null once the channel was told why it failed. */
  transcribe: (
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ) => Promise<string | null>
  /** Best-effort: the text reply already went out. */
  speak: (adapter: ChannelAdapter, text: string, meta?: InboundMeta) => Promise<void>
  prepareAnswer: (
    adapter: ChannelAdapter,
    sessionId: string,
    meta?: InboundMeta,
  ) => Promise<VoiceAnswerPreparation>
}

type Say = (message: string) => Promise<unknown>

const failureText = (e: unknown) =>
  fillTemplate(answerRouterCopy().voiceFailed, {
    error: e instanceof Error ? e.message : String(e),
  })

export function createRemoteSpeech(deps: RemoteSpeechDeps): RemoteSpeech {
  async function failed(say: Say, e: unknown): Promise<false> {
    deps.log('homeAgent: speech model download failed', e)
    await say(failureText(e))
    return false
  }

  /** The transcription model, downloaded through `download` when missing; the channel hears any refusal. */
  async function prepareModel(
    say: Say,
    download: (models: DownloadModelParam[]) => Promise<boolean>,
  ): Promise<VoiceAnswerPreparation> {
    if (!deps.transcriptionModel.installed()) {
      await say(answerRouterCopy().voiceNoBackend)
      return { ready: false }
    }
    const fetch = async (models: DownloadModelParam[]) => {
      try {
        if (await download(models)) return true
        await say(answerRouterCopy().voiceModelDeclined)
        return false
      } catch (e) {
        return failed(say, e)
      }
    }
    try {
      const missing = await deps.transcriptionModel.missing()
      return missing.length === 0 ? { ready: true } : { downloading: fetch(missing) }
    } catch (e) {
      return { ready: await failed(say, e) }
    }
  }

  async function transcribe(
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ): Promise<string | null> {
    const say = (message: string) => adapter.reply(adapter.formatRichSnippet(message), meta)
    const preparation = await prepareModel(say, deps.transcriptionModel.download)
    const ready = 'downloading' in preparation ? await preparation.downloading : preparation.ready
    if (!ready) return null
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
      const noEndpoint = deps.transcription.isNoEndpoint(e)
      await say(noEndpoint ? answerRouterCopy().voiceNoBackend : failureText(e))
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

  function prepareAnswer(
    adapter: ChannelAdapter,
    sessionId: string,
    meta?: InboundMeta,
  ): Promise<VoiceAnswerPreparation> {
    // A post, not a reply: a reply would settle a Home Agent answer still streaming.
    const say = (message: string) => adapter.post(adapter.formatMarkdown(message), meta)
    return prepareModel(say, (models) => deps.answerDownload(models, sessionId))
  }

  return { transcribe, speak, prepareAnswer }
}
