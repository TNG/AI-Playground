import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// Speech-to-text and text-to-speech each accept a configurable OpenAI-compatible
// endpoint as an alternative to the OVMS servers. It exists for hosts where OVMS
// cannot serve them at all — notably macOS, where the OVMS binary is installed
// but not executable, so starting it fails with ENOEXEC while the service still
// reports isSetUp. These tests pin the resulting rule: once an endpoint is
// configured it is the source, and nothing local is started, downloaded or
// required.

const startTranscriptionServer = vi.fn(async () => {
  throw new Error('spawn ENOEXEC')
})
const stopTranscriptionServer = vi.fn(async () => {})
const startSpeechServer = vi.fn(async () => {
  throw new Error('spawn ENOEXEC')
})
const stopSpeechServer = vi.fn(async () => {})
const getTranscriptionServerUrl = vi.fn(async (): Promise<string | null> => null)
const getSpeechServerUrl = vi.fn(async (): Promise<string | null> => null)

// An OVMS that looks perfectly healthy from the renderer's side: installed and
// running. On macOS this is exactly the state in which its servers cannot start.
vi.mock('@/assets/js/store/backendServices', () => ({
  useBackendServices: () => ({
    info: [{ serviceName: 'openvino-backend', isSetUp: true, status: 'running' }],
    startTranscriptionServer,
    stopTranscriptionServer,
    getTranscriptionServerUrl,
    startSpeechServer,
    stopSpeechServer,
    getSpeechServerUrl,
  }),
}))

const checkTranscriptionModelExists = vi.fn(async () => false)
const checkSpeechModelExists = vi.fn(async () => false)

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({
    checkTranscriptionModelExists,
    checkSpeechModelExists,
    getMissingTranscriptionModel: vi.fn(async () => []),
    getMissingSpeechModel: vi.fn(async () => []),
  }),
}))

const showWarningDialog = vi.fn()
const showDownloadDialog = vi.fn()

vi.mock('@/assets/js/store/dialogs', () => ({
  useDialogStore: () => ({ showWarningDialog, showDownloadDialog }),
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

beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  getTranscriptionServerUrl.mockResolvedValue(null)
  getSpeechServerUrl.mockResolvedValue(null)
})

describe('speech-to-text with a configured fallback endpoint', () => {
  async function sttWithFallback() {
    const { useSpeechToText } = await import('@/assets/js/store/speechToText')
    const stt = useSpeechToText()
    stt.fallback = { enabled: true, baseUrl: 'http://127.0.0.1:2022/v1', model: '', apiKey: 'k' }
    return stt
  }

  it('enables without touching OVMS, even though OVMS reports itself installed', async () => {
    const stt = await sttWithFallback()

    await stt.toggle(true)

    expect(stt.enabled).toBe(true)
    expect(startTranscriptionServer).not.toHaveBeenCalled()
    expect(showWarningDialog).not.toHaveBeenCalled()
    expect(showDownloadDialog).not.toHaveBeenCalled()
  })

  it('needs no Whisper model', async () => {
    const stt = await sttWithFallback()

    await stt.toggle(true)

    expect(checkTranscriptionModelExists).not.toHaveBeenCalled()
  })

  it('resolves to the fallback even when an OVMS server is up', async () => {
    getTranscriptionServerUrl.mockResolvedValue('http://127.0.0.1:29200/v3')
    const stt = await sttWithFallback()

    expect(await stt.resolveTranscription()).toEqual({
      baseURL: 'http://127.0.0.1:2022/v1',
      model: 'whisper-1',
      apiKey: 'k',
    })
  })

  it('starts no server on startup and stays enabled', async () => {
    const stt = await sttWithFallback()
    stt.enabled = true

    await stt.initialize()
    await stt.ensureTranscriptionServerRunning()

    expect(stt.enabled).toBe(true)
    expect(startTranscriptionServer).not.toHaveBeenCalled()
  })

  it('disables without stopping a server it never started', async () => {
    const stt = await sttWithFallback()
    stt.enabled = true

    await stt.toggle(false)

    expect(stt.enabled).toBe(false)
    expect(stopTranscriptionServer).not.toHaveBeenCalled()
  })

  it('still requires OVMS when no fallback is configured', async () => {
    const { useSpeechToText } = await import('@/assets/js/store/speechToText')
    const stt = useSpeechToText()

    await stt.toggle(true)

    // OVMS is installed here, so it gets as far as looking for the model.
    expect(checkTranscriptionModelExists).toHaveBeenCalled()
    expect(stt.enabled).toBe(false)
  })
})

describe('text-to-speech with a configured fallback endpoint', () => {
  async function ttsWithFallback() {
    const { useTextToSpeech } = await import('@/assets/js/store/textToSpeech')
    const tts = useTextToSpeech()
    tts.fallback = {
      enabled: true,
      baseUrl: 'http://127.0.0.1:2022/v1',
      model: '',
      voice: '',
      apiKey: 'k',
    }
    return tts
  }

  it('enables without touching OVMS', async () => {
    const tts = await ttsWithFallback()

    await tts.toggle(true)

    expect(tts.enabled).toBe(true)
    expect(startSpeechServer).not.toHaveBeenCalled()
    expect(checkSpeechModelExists).not.toHaveBeenCalled()
  })

  it('resolves to the fallback even when an OVMS server is up', async () => {
    getSpeechServerUrl.mockResolvedValue('http://127.0.0.1:29300/v3')
    const tts = await ttsWithFallback()

    expect(await tts.resolveSpeech()).toEqual({
      baseURL: 'http://127.0.0.1:2022/v1',
      model: 'tts-1',
      voice: 'af_heart',
      apiKey: 'k',
    })
  })

  it('starts no server on startup and stays enabled', async () => {
    const tts = await ttsWithFallback()
    tts.enabled = true

    await tts.initialize()
    await tts.ensureSpeechServerRunning()

    expect(tts.enabled).toBe(true)
    expect(startSpeechServer).not.toHaveBeenCalled()
  })
})
