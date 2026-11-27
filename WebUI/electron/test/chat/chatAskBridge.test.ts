import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAskPayload } from '@/types/chatRequests'
import { createCancellation } from '@/assets/js/errors/appError'

// The renderer half of `chat:ask`: the speech engine is mocked at its seam, and
// what is under test is the answer main gets back — above all, that a declined
// model download stays a decline rather than an ordinary failure.

type Handler = (payload: ChatAskPayload) => void

const answerMock = vi.fn<(payload: unknown) => Promise<void>>()
let handler: Handler | undefined

const synthesizeClipMock = vi.fn()
const readyTranscriptionMock = vi.fn()
const transcribeMock = vi.fn()
vi.mock('@/assets/js/speech/speechIO', () => ({
  synthesizeClip: (...args: unknown[]) => synthesizeClipMock(...args),
  readyTranscriptionForInput: () => readyTranscriptionMock(),
  transcribe: (...args: unknown[]) => transcribeMock(...args),
}))
vi.mock('@/assets/js/store/channels', () => ({ useChannels: () => ({}) }))
vi.mock('@/lib/render3dThumbnail', () => ({ render3dThumbnail: vi.fn() }))

vi.stubGlobal('window', {
  electronAPI: {
    chat: {
      answer: answerMock,
      onAsk: (callback: Handler) => {
        handler = callback
      },
    },
  },
})

const { startChatAskBridge } = await import('@/assets/js/chat/chatAskBridge')

function ask(payload: ChatAskPayload): Promise<Record<string, unknown>> {
  handler!(payload)
  return vi.waitFor(() => {
    const reply = answerMock.mock.calls.find(
      ([answer]) => !(answer as { progress?: boolean }).progress,
    )
    if (!reply) throw new Error('no answer yet')
    return reply[0] as Record<string, unknown>
  })
}

describe('chatAskBridge', () => {
  beforeAll(() => startChatAskBridge())

  beforeEach(() => {
    answerMock.mockReset().mockResolvedValue()
    synthesizeClipMock.mockReset()
    readyTranscriptionMock.mockReset().mockResolvedValue({ downloadPrompted: false })
    transcribeMock.mockReset()
  })

  it('answers a declined synthesis download as declined', async () => {
    synthesizeClipMock.mockRejectedValue(
      createCancellation({ userMessage: 'Kokoro speech model download was cancelled' }),
    )

    const answer = await ask({ requestId: 'r1', kind: 'speech-synthesize', text: 'hi', voice: {} })

    expect(answer).toEqual({
      requestId: 'r1',
      error: 'Kokoro speech model download was cancelled',
      declined: true,
    })
  })

  it('answers a declined transcription download as declined', async () => {
    readyTranscriptionMock.mockRejectedValue(
      createCancellation({ userMessage: 'Whisper model download was cancelled' }),
    )

    const answer = await ask({ requestId: 'r2', kind: 'speech-transcribe', audioBase64: 'QQ==' })

    expect(answer).toMatchObject({ requestId: 'r2', declined: true })
  })

  it('answers any other failure as a plain error', async () => {
    synthesizeClipMock.mockRejectedValue(new Error('disk full'))

    const answer = await ask({ requestId: 'r3', kind: 'speech-synthesize', text: 'hi', voice: {} })

    expect(answer).toEqual({ requestId: 'r3', error: 'disk full' })
  })
})
