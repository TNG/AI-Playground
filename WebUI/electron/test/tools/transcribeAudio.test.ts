import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/assets/js/store/activities', () => ({
  useActivities: () => ({ begin: vi.fn(), end: vi.fn() }),
}))
vi.mock('@/assets/js/store/conversations', () => ({
  useConversations: () => ({ activeKey: '' }),
}))
vi.mock('@/assets/js/speech/speechIO', () => ({
  readyTranscriptionForInput: vi.fn(),
  transcribe: vi.fn(),
}))

const { filePartToBlob } = await import('@/assets/js/tools/transcribeAudio')

describe('filePartToBlob', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {
      electronAPI: {
        readAipgMediaAsBase64: vi.fn(),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('decodes a data URL without fetch', async () => {
    const blob = await filePartToBlob('data:audio/wav;base64,QQ==', 'audio/wav')
    expect(blob.type).toBe('audio/wav')
    expect(await blob.text()).toBe('A')
  })

  it('unwraps a v7 { type: url } file part', async () => {
    const blob = await filePartToBlob(
      { type: 'url', url: 'data:audio/wav;base64,QQ==' },
      'audio/wav',
    )
    expect(blob.type).toBe('audio/wav')
    expect(await blob.text()).toBe('A')
  })

  it('reads aipg-media:// through main instead of fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const read = window.electronAPI.readAipgMediaAsBase64 as ReturnType<typeof vi.fn>
    read.mockResolvedValue({ success: true, data: 'QQ==' })

    const blob = await filePartToBlob('aipg-media://voice.wav', 'audio/wav')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(read).toHaveBeenCalledWith('aipg-media://voice.wav')
    expect(blob.type).toBe('audio/wav')
    expect(await blob.text()).toBe('A')
  })

  it('copies raw bytes', async () => {
    const blob = await filePartToBlob(new Uint8Array([1, 2, 3]), 'audio/ogg')
    expect(blob.type).toBe('audio/ogg')
    expect(blob.size).toBe(3)
  })
})
