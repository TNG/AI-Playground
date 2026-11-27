import { answerRouterCopy } from '@/lib/answerRouterWording'
import { markdownToSpeechText } from '@/lib/markdownToSpeech'
import { fillTemplate } from '@/lib/fillTemplate'
import type { ChannelAdapter } from './adapter'
import type { ChannelSpeech, VoicePreparation } from './answerRouter'
import type { InboundMeta, RemoteAudio } from './types'

export type SpeechClip = { audioBase64: string; mediaType: string }

export type RemoteSpeechDeps = {
  transcription: {
    /** Never asks: starts the engine only when it and its model are already there. */
    ready: () => Promise<void>
    transcribe: (audio: RemoteAudio) => Promise<string>
    isNoEndpoint: (error: unknown) => boolean
  }
  synthesis: {
    /** Null when the engine or its model is missing; never asks. */
    synthesize: (text: string) => Promise<SpeechClip | null>
  }
  transcriptionModel: {
    /** True for a configured fallback endpoint too. */
    installed: () => boolean
    missing: () => Promise<DownloadModelParam[]>
    /** Asked in the channel that sent the voice message; false when declined. */
    download: (
      models: DownloadModelParam[],
      adapter: ChannelAdapter,
      meta?: InboundMeta,
    ) => Promise<boolean>
  }
  synthesisModel: {
    missing: () => Promise<boolean>
    /** False when declined. */
    install: (adapter: ChannelAdapter, meta?: InboundMeta) => Promise<boolean>
  }
  log: (message: string, error: unknown) => void
}

export type RemoteSpeech = ChannelSpeech & {
  /** A spoken reply, or null when there is none to give; best-effort, the text already went out. */
  voiceClip: (
    adapter: ChannelAdapter,
    text: string,
    meta?: InboundMeta,
  ) => Promise<SpeechClip | null>
}

type Say = (message: string) => Promise<unknown>

const failureText = (e: unknown) =>
  fillTemplate(answerRouterCopy().voiceFailed, {
    error: e instanceof Error ? e.message : String(e),
  })

export function createRemoteSpeech(deps: RemoteSpeechDeps): RemoteSpeech {
  async function failed(say: Say, e: unknown): Promise<false> {
    deps.log('channels: speech model download failed', e)
    await say(failureText(e))
    return false
  }

  /** The transcription model, downloaded when missing; the channel hears any refusal. */
  async function prepareModel(
    say: Say,
    adapter: ChannelAdapter,
    meta?: InboundMeta,
  ): Promise<VoicePreparation> {
    if (!deps.transcriptionModel.installed()) {
      await say(answerRouterCopy().voiceNoBackend)
      return { ready: false }
    }
    const fetch = async (models: DownloadModelParam[]) => {
      try {
        if (await deps.transcriptionModel.download(models, adapter, meta)) return true
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

  function prepare(adapter: ChannelAdapter, meta?: InboundMeta): Promise<VoicePreparation> {
    const say = (message: string) => adapter.post(adapter.formatMarkdown(message), meta)
    return prepareModel(say, adapter, meta)
  }

  async function transcribe(
    adapter: ChannelAdapter,
    audio: RemoteAudio[],
    meta?: InboundMeta,
  ): Promise<string | null> {
    const say = (message: string) => adapter.reply(adapter.formatRichSnippet(message), meta)
    const preparation = await prepareModel(say, adapter, meta)
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
      deps.log('channels: audio transcription failed', e)
      const noEndpoint = deps.transcription.isNoEndpoint(e)
      await say(noEndpoint ? answerRouterCopy().voiceNoBackend : failureText(e))
      return null
    } finally {
      stopTyping()
    }
  }

  async function voiceClip(
    adapter: ChannelAdapter,
    text: string,
    meta?: InboundMeta,
  ): Promise<SpeechClip | null> {
    const spoken = markdownToSpeechText(text ?? '').trim()
    if (!spoken) return null
    try {
      const clip = await deps.synthesis.synthesize(spoken)
      if (clip || !(await installMissingModel(adapter, meta))) return clip
      return await deps.synthesis.synthesize(spoken)
    } catch (e) {
      deps.log('channels: voice reply failed', e)
      return null
    }
  }

  async function installMissingModel(adapter: ChannelAdapter, meta?: InboundMeta) {
    return (await deps.synthesisModel.missing()) && deps.synthesisModel.install(adapter, meta)
  }

  return { prepare, transcribe, voiceClip }
}
