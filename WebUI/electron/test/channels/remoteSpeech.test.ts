import { describe, expect, it } from 'vitest'
import {
  createRemoteSpeech,
  type RemoteSpeechDeps,
} from '../../../src/assets/js/store/channels/remoteSpeech'
import type { ChannelAdapter } from '../../../src/assets/js/store/channels/adapter'
import type { InboundMeta, RemoteAudio } from '../../../src/assets/js/store/channels/types'

function fakeChannel() {
  const sent: string[] = []
  const posted: string[] = []
  const voices: { base64: string; mime: string; meta?: InboundMeta }[] = []
  const adapter = {
    kind: 'telegram',
    formatRichSnippet: (html: string) => html,
    formatMarkdown: (md: string) => md,
    reply: async (text: string) => {
      sent.push(text)
      return { success: true }
    },
    voice: async (base64: string, mime: string, meta?: InboundMeta) => {
      voices.push({ base64, mime, meta })
      return { success: true }
    },
    post: async (text: string) => {
      posted.push(text)
      return { success: true }
    },
    startTypingHeartbeat: () => () => {},
  } as unknown as ChannelAdapter
  return { adapter, sent, posted, voices }
}

const NO_ENDPOINT = new Error('no endpoint')

function fakeDeps(overrides: {
  sttReady?: boolean
  transcripts?: Record<string, string>
  transcribeError?: Error
  speakAllowed?: boolean
  ttsReady?: boolean
  synthesizeError?: Error
}) {
  const logged: string[] = []
  const spoken: string[] = []
  const deps: RemoteSpeechDeps = {
    transcription: {
      ready: async () => {},
      transcribe: async (audio: RemoteAudio) => {
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
        if (overrides.ttsReady === false) return null
        spoken.push(text)
        return { audioBase64: `wav:${text}`, mediaType: 'audio/wav' }
      },
    },
    log: (message) => logged.push(message),
  }
  return { deps, logged, spoken }
}

const clip = (id: string): RemoteAudio => ({ mime: 'audio/ogg', data_base64: id })

describe('remote speech: transcribing a channel voice message', () => {
  it('joins the transcripts of every clip when speech-to-text is ready', async () => {
    const { adapter, sent } = fakeChannel()
    const { deps } = fakeDeps({ transcripts: { a: ' hello ', b: 'world' } })

    const text = await createRemoteSpeech(deps).transcribe(adapter, [clip('a'), clip('b')])

    expect(text).toBe('hello world')
    expect(sent).toEqual([])
  })

  it('warns with the setup steps and drops the message when no speech-to-text exists', async () => {
    const { adapter, sent } = fakeChannel()
    const { deps } = fakeDeps({ sttReady: false })

    const text = await createRemoteSpeech(deps).transcribe(adapter, [clip('a')])

    expect(text).toBeNull()
    expect(sent).toEqual([
      '⚠️ No speech-to-text is available. Install the OpenVINO backend or the standalone Whisper backend, or configure a fallback transcription endpoint in the Speech to Text preset settings.',
    ])
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

  it('silently sends no voice message when the text-to-speech model is missing', async () => {
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

const WHISPER = {
  repo_id: 'OpenVINO/whisper-base',
  type: 'STT',
  backend: 'openvino',
} as DownloadModelParam
const DECLINED = new Error('declined')

function answerDeps(overrides: {
  missing?: DownloadModelParam[] | 'no-backend'
  download?: 'declined' | Error
}) {
  const { deps } = fakeDeps({})
  const asked: { models: DownloadModelParam[]; sessionId: string }[] = []
  deps.answerTranscription = {
    missing: async () => overrides.missing ?? [],
    download: async (models, sessionId) => {
      asked.push({ models, sessionId })
      if (overrides.download === 'declined') throw DECLINED
      if (overrides.download) throw overrides.download
    },
    isDeclined: (e) => e === DECLINED,
  }
  return { deps, asked }
}

describe('remote speech: readying a voice Answer to an agent', () => {
  it('asks nothing when the speech model is already there', async () => {
    const { adapter, posted } = fakeChannel()
    const { deps, asked } = answerDeps({})

    expect(await createRemoteSpeech(deps).prepareAnswer(adapter, 'asteroids')).toBe(true)
    expect(asked).toEqual([])
    expect(posted).toEqual([])
  })

  it('asks the session’s download question for a missing model, then goes on', async () => {
    const { adapter, posted } = fakeChannel()
    const { deps, asked } = answerDeps({ missing: [WHISPER] })

    expect(await createRemoteSpeech(deps).prepareAnswer(adapter, 'asteroids')).toBe(true)
    expect(asked).toEqual([{ models: [WHISPER], sessionId: 'asteroids' }])
    expect(posted).toEqual([])
  })

  it('says the voice was not transcribed when the download was declined', async () => {
    const { adapter, posted } = fakeChannel()
    const { deps } = answerDeps({ missing: [WHISPER], download: 'declined' })

    expect(await createRemoteSpeech(deps).prepareAnswer(adapter, 'asteroids')).toBe(false)
    expect(posted).toEqual([
      'Voice not transcribed: speech model not downloaded. Send text instead.',
    ])
  })

  it('says the download failed when it did', async () => {
    const { adapter, posted } = fakeChannel()
    const { deps } = answerDeps({ missing: [WHISPER], download: new Error('disk full') })

    expect(await createRemoteSpeech(deps).prepareAnswer(adapter, 'asteroids')).toBe(false)
    expect(posted).toEqual(['⚠️ Could not download the speech model: disk full'])
  })

  it('says a backend must be installed on the desktop when there is none', async () => {
    const { adapter, posted } = fakeChannel()
    const { deps, asked } = answerDeps({ missing: 'no-backend' })

    expect(await createRemoteSpeech(deps).prepareAnswer(adapter, 'asteroids')).toBe(false)
    expect(asked).toEqual([])
    expect(posted).toEqual([
      '⚠️ Voice not transcribed: install a speech-to-text backend in AI Playground on the desktop.',
    ])
  })
})
