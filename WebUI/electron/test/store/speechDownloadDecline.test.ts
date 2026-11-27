import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createCancellation, isCancellation } from '@/assets/js/errors/appError'

// A declined speech-model download must stay a cancellation on its way out of
// the speech stores: an agent's speech tool tells "the user said no" apart from
// "it broke" by it, and stops asking only for the former.

vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () => ({
    info: [{ serviceName: 'openvino-backend', isSetUp: true, status: 'running' }],
    startTranscriptionServer: vi.fn(),
    startSpeechServer: vi.fn(),
    getTranscriptionServerUrl: vi.fn(async () => null),
    getSpeechServerUrl: vi.fn(async () => null),
  }),
}))

const missing = [{ repo_id: 'some/speech-model', type: 'tts', backend: 'openvino' }]
vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({
    checkTranscriptionModelExists: vi.fn(async () => false),
    checkSpeechModelExists: vi.fn(async () => false),
    getMissingTranscriptionModel: vi.fn(async () => missing),
    getMissingSpeechModel: vi.fn(async () => missing),
    getMissingQwenTtsModels: vi.fn(async () => missing),
  }),
}))

const requestDownload = vi.fn<() => Promise<void>>()
vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload,
  notify: vi.fn(),
  requestVramWarning: vi.fn(),
  REMOTE_DOWNLOAD_GRANT: 'download:remote-turns',
  vramWarningGrantKey: (presetName: string) => `vram-warning:${presetName}`,
}))

vi.mock('@/assets/js/store/setupWizard', () => ({
  useSetupWizard: () => ({ openWizard: vi.fn() }),
}))
vi.mock('@/assets/js/store/productMode', () => ({
  useProductMode: () => ({ isNvidiaModeSelected: false }),
}))
vi.mock('@/assets/js/toast', () => ({
  success: vi.fn(),
  warning: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}))
vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

const { useTextToSpeech } = await import('@/assets/js/store/textToSpeech')
const { useSpeechToText } = await import('@/assets/js/store/speechToText')
const { useQwen3TextToSpeech } = await import('@/assets/js/store/qwen3TextToSpeech')

beforeEach(() => {
  setActivePinia(createPinia())
  requestDownload.mockReset()
})

async function failureOf(work: () => Promise<unknown>): Promise<unknown> {
  return work().then(
    () => {
      throw new Error('expected a rejection')
    },
    (error: unknown) => error,
  )
}

describe('a declined speech-model download', () => {
  beforeEach(() => {
    requestDownload.mockRejectedValue(createCancellation({ technicalMessage: 'declined' }))
  })

  it('stays a cancellation for Kokoro', async () => {
    const tts = useTextToSpeech()
    tts.selectedEngine = 'kokoro'
    const error = await failureOf(() => tts.ensureKokoroReady())
    expect(isCancellation(error)).toBe(true)
    expect(error).toMatchObject({ userMessage: 'Kokoro speech model download was cancelled' })
  })

  it('stays a cancellation for OpenVINO Whisper', async () => {
    const stt = useSpeechToText()
    stt.selectedSttEngine = 'whisper'
    const error = await failureOf(() => stt.ensureWhisperReady())
    expect(isCancellation(error)).toBe(true)
  })

  it('stays a cancellation for Qwen3 Text To Speech', async () => {
    const error = await failureOf(() => useQwen3TextToSpeech().ensureModelInstalled())
    expect(isCancellation(error)).toBe(true)
  })
})

describe('a failed speech-model download', () => {
  it('stays a failure', async () => {
    requestDownload.mockRejectedValue(new Error('disk full'))
    const tts = useTextToSpeech()
    tts.selectedEngine = 'kokoro'
    const error = await failureOf(() => tts.ensureKokoroReady())
    expect(isCancellation(error)).toBe(false)
  })
})
