import { describe, expect, it } from 'vitest'
import {
  createRemoteSpeech,
  type RemoteSpeechDeps,
} from '../../../src/assets/js/store/channels/remoteSpeech'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type { InboundMeta, RemoteAudio } from '../../../src/assets/js/store/channels/types'

function fakeChannel() {
  const sent: string[] = []
  const voices: { base64: string; mime: string; meta?: InboundMeta }[] = []
  const adapter = {
    kind: 'telegram',
    formatRichSnippet: (html: string) => html,
    reply: async (text: string) => {
      sent.push(text)
      return { success: true }
    },
    voice: async (base64: string, mime: string, meta?: InboundMeta) => {
      voices.push({ base64, mime, meta })
      return { success: true }
    },
    startTypingHeartbeat: () => () => {},
  } as unknown as ChannelAdapter
  return { adapter, sent, voices }
}

const NO_ENDPOINT = new Error('no endpoint')
const STT_MODEL: DownloadModelParam = {
  repo_id: 'OpenVINO/whisper-base-fp16-ov',
  type: 'STT',
  backend: 'openvino',
  model_path: 'models/STT',
}

function fakeDeps(overrides: {
  sttReady?: boolean
  transcripts?: Record<string, string>
  transcribeError?: Error
  speakAllowed?: boolean
  ttsReady?: boolean
  synthesizeError?: Error
  sttInstalled?: boolean
  sttModelMissing?: boolean
  downloadAnswer?: 'approve' | 'decline'
  preGranted?: boolean
  ttsModelMissing?: boolean
  ttsDownloadAnswer?: 'yes' | 'no' | Error
}) {
  const logged: string[] = []
  const spoken: string[] = []
  const events: string[] = []
  let sttModelOnDisk = !overrides.sttModelMissing
  let ttsModelOnDisk = !overrides.ttsModelMissing
  const deps: RemoteSpeechDeps = {
    transcription: {
      ready: async () => {},
      transcribe: async (audio: RemoteAudio) => {
        events.push('transcribe')
        if (!sttModelOnDisk) throw NO_ENDPOINT
        if (overrides.transcribeError) throw overrides.transcribeError
        if (overrides.sttReady === false) throw NO_ENDPOINT
        return overrides.transcripts?.[audio.data_base64] ?? ''
      },
      isNoEndpoint: (e) => e === NO_ENDPOINT,
    },
    synthesis: {
      allowed: () => overrides.speakAllowed ?? true,
      synthesize: async (text) => {
        if (overrides.synthesizeError) throw overrides.synthesizeError
        if (overrides.ttsReady === false || !ttsModelOnDisk) return null
        spoken.push(text)
        return { audioBase64: `wav:${text}`, mediaType: 'audio/wav' }
      },
    },
    transcriptionModel: {
      installed: () => overrides.sttInstalled ?? true,
      missing: async () => (sttModelOnDisk ? [] : [STT_MODEL]),
      download: async (models) => {
        if (!overrides.preGranted) {
          events.push(`question:${models.map((m) => m.repo_id).join(',')}`)
          if (overrides.downloadAnswer === 'decline') return false
        }
        events.push('download')
        sttModelOnDisk = true
        return true
      },
    },
    synthesisModel: {
      missing: async () => !ttsModelOnDisk,
      install: async (_adapter, meta) => {
        events.push(`asked:${JSON.stringify(meta ?? null)}`)
        const answer = overrides.ttsDownloadAnswer ?? 'yes'
        if (answer instanceof Error) throw answer
        if (answer === 'no') return false
        ttsModelOnDisk = true
        return true
      },
    },
    log: (message) => logged.push(message),
  }
  return { deps, logged, spoken, events }
}

const NO_BACKEND =
  '⚠️ Voice not transcribed: a speech-to-text backend must be installed in AI Playground on the desktop.'

const clip = (id: string): RemoteAudio => ({ mime: 'audio/ogg', data_base64: id })

describe('remote speech: transcribing a channel voice message', () => {
  it('joins the transcripts of every clip when speech-to-text is ready', async () => {
    const { adapter, sent } = fakeChannel()
    const { deps } = fakeDeps({ transcripts: { a: ' hello ', b: 'world' } })

    const text = await createRemoteSpeech(deps).transcribe(adapter, [clip('a'), clip('b')])

    expect(text).toBe('hello world')
    expect(sent).toEqual([])
  })

  it('asks no question when the speech model is already on disk', async () => {
    const { adapter } = fakeChannel()
    const { deps, events } = fakeDeps({ transcripts: { a: 'hi' } })

    await createRemoteSpeech(deps).transcribe(adapter, [clip('a')])

    expect(events).toEqual(['transcribe'])
  })

  it('asks to download a missing speech model, then transcribes the voice message', async () => {
    const { adapter, sent } = fakeChannel()
    const { deps, events } = fakeDeps({
      sttModelMissing: true,
      downloadAnswer: 'approve',
      transcripts: { a: 'hello' },
    })

    const text = await createRemoteSpeech(deps).transcribe(adapter, [clip('a')])

    expect(text).toBe('hello')
    expect(events).toEqual(['question:OpenVINO/whisper-base-fp16-ov', 'download', 'transcribe'])
    expect(sent).toEqual([])
  })

  it('downloads without asking under a pre-grant, then transcribes', async () => {
    const { adapter } = fakeChannel()
    const { deps, events } = fakeDeps({
      sttModelMissing: true,
      preGranted: true,
      transcripts: { a: 'hello' },
    })

    const text = await createRemoteSpeech(deps).transcribe(adapter, [clip('a')])

    expect(text).toBe('hello')
    expect(events).toEqual(['download', 'transcribe'])
  })

  it('drops the voice message and suggests text when the download is declined', async () => {
    const { adapter, sent } = fakeChannel()
    const { deps, events } = fakeDeps({ sttModelMissing: true, downloadAnswer: 'decline' })

    const text = await createRemoteSpeech(deps).transcribe(adapter, [clip('a')])

    expect(text).toBeNull()
    expect(events).toEqual(['question:OpenVINO/whisper-base-fp16-ov'])
    expect(sent).toEqual(['Voice not transcribed: speech model not downloaded. Send text instead.'])
  })

  it('says a speech-to-text backend must be installed on the desktop when none is', async () => {
    const { adapter, sent } = fakeChannel()
    const { deps, events } = fakeDeps({ sttInstalled: false })

    const text = await createRemoteSpeech(deps).transcribe(adapter, [clip('a')])

    expect(text).toBeNull()
    expect(events).toEqual([])
    expect(sent).toEqual([NO_BACKEND])
  })

  it('gives the same install message when no endpoint answers', async () => {
    const { adapter, sent } = fakeChannel()
    const { deps } = fakeDeps({ sttReady: false })

    const text = await createRemoteSpeech(deps).transcribe(adapter, [clip('a')])

    expect(text).toBeNull()
    expect(sent).toEqual([NO_BACKEND])
  })

  it('tells the sender why transcription failed and drops the message', async () => {
    const { adapter, sent } = fakeChannel()
    const { deps } = fakeDeps({ transcribeError: new Error('server returned 500') })

    const text = await createRemoteSpeech(deps).transcribe(adapter, [clip('a')])

    expect(text).toBeNull()
    expect(sent).toEqual(['⚠️ Could not transcribe the audio: server returned 500'])
  })
})

describe('remote speech: speaking a reply', () => {
  it('sends the reply as a voice message, read without its markdown', async () => {
    const { adapter, voices } = fakeChannel()
    const { deps } = fakeDeps({})
    const meta = { chatId: 7 } as unknown as InboundMeta

    await createRemoteSpeech(deps).speak(adapter, '**Done.** See you', meta)

    expect(voices).toEqual([{ base64: 'wav:Done. See you', mime: 'audio/wav', meta }])
  })

  it('silently sends no voice message when no text-to-speech engine can serve', async () => {
    const { adapter, sent, voices } = fakeChannel()
    const { deps } = fakeDeps({ ttsReady: false })

    await createRemoteSpeech(deps).speak(adapter, 'Done.')

    expect(voices).toEqual([])
    expect(sent).toEqual([])
  })

  it('does not synthesize when spoken replies are off', async () => {
    const { adapter, voices } = fakeChannel()
    const { deps, spoken } = fakeDeps({ speakAllowed: false })

    await createRemoteSpeech(deps).speak(adapter, 'Done.')

    expect(spoken).toEqual([])
    expect(voices).toEqual([])
  })

  it('does not synthesize a reply with nothing to say', async () => {
    const { adapter, voices } = fakeChannel()
    const { deps, spoken } = fakeDeps({})

    await createRemoteSpeech(deps).speak(adapter, '   ')

    expect(spoken).toEqual([])
    expect(voices).toEqual([])
  })

  it('keeps a failed synthesis out of the channel', async () => {
    const { adapter, sent, voices } = fakeChannel()
    const { deps, logged } = fakeDeps({ synthesizeError: new Error('engine crashed') })

    await createRemoteSpeech(deps).speak(adapter, 'Done.')

    expect(voices).toEqual([])
    expect(sent).toEqual([])
    expect(logged).toHaveLength(1)
  })
})

describe('remote speech: speaking a reply with the text-to-speech model missing', () => {
  it('asks the sender to download the model, then sends the voice message', async () => {
    const { adapter, voices } = fakeChannel()
    const { deps, events } = fakeDeps({ ttsModelMissing: true })
    const meta = { chatId: 7 } as unknown as InboundMeta

    await createRemoteSpeech(deps).speak(adapter, 'Done.', meta)

    expect(events).toEqual(['asked:{"chatId":7}'])
    expect(voices).toEqual([{ base64: 'wav:Done.', mime: 'audio/wav', meta }])
  })

  it('sends nothing more when the sender declines the download', async () => {
    const { adapter, sent, voices } = fakeChannel()
    const { deps, logged, spoken } = fakeDeps({ ttsModelMissing: true, ttsDownloadAnswer: 'no' })

    await createRemoteSpeech(deps).speak(adapter, 'Done.')

    expect(spoken).toEqual([])
    expect(voices).toEqual([])
    expect(sent).toEqual([])
    expect(logged).toEqual([])
  })

  it('keeps a failed download out of the channel', async () => {
    const { adapter, sent, voices } = fakeChannel()
    const { deps, logged } = fakeDeps({
      ttsModelMissing: true,
      ttsDownloadAnswer: new Error('network down'),
    })

    await createRemoteSpeech(deps).speak(adapter, 'Done.')

    expect(voices).toEqual([])
    expect(sent).toEqual([])
    expect(logged).toHaveLength(1)
  })

  it('does not ask about a download when spoken replies are off', async () => {
    const { adapter, voices } = fakeChannel()
    const { deps, events } = fakeDeps({ ttsModelMissing: true, speakAllowed: false })

    await createRemoteSpeech(deps).speak(adapter, 'Done.')

    expect(events).toEqual([])
    expect(voices).toEqual([])
  })
})
