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
