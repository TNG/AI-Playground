import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  ensureChatBackendReady,
  lastChatBackendLoadActiveForTest,
  lastChatBackendLoadForTest,
  reloadLastChatBackend,
  resetChatReadinessForTest,
  setChatReadinessDeps,
  setLastChatBackendLoadActive,
} = await import('../../chat/chatReadiness')

function wire(overrides: Record<string, unknown> = {}) {
  const ensureBackendReadiness = vi.fn(async () => {})
  const awaitChatWindow = vi.fn(async () => {})
  const stopOvmsImageServer = vi.fn(async () => {})
  const notifyHomeAgentUpstreamReady = vi.fn()
  const getService = vi.fn(() => ({
    ensureBackendReadiness,
    baseUrl: 'http://127.0.0.1:39100',
  }))
  setChatReadinessDeps({
    getService,
    awaitChatWindow,
    stopOvmsImageServer,
    notifyHomeAgentUpstreamReady,
    ...overrides,
  })
  return {
    ensureBackendReadiness,
    awaitChatWindow,
    stopOvmsImageServer,
    notifyHomeAgentUpstreamReady,
    getService,
  }
}

const loadArgs = {
  serviceName: 'llamacpp-backend',
  llmModelName: 'Qwen3-9B',
  embeddingModelName: 'bge',
  contextSize: 8192,
  modelArgs: '--jinja',
}

describe('chatReadiness', () => {
  beforeEach(() => {
    resetChatReadinessForTest()
  })

  it('throws when deps are not wired', async () => {
    await expect(ensureChatBackendReady(loadArgs)).rejects.toThrow('not wired')
  })

  it('admits the GPU window, stops OVMS image, loads, remembers, and notifies', async () => {
    const d = wire()
    await ensureChatBackendReady(loadArgs)

    expect(d.awaitChatWindow).toHaveBeenCalledTimes(1)
    expect(d.stopOvmsImageServer).toHaveBeenCalledTimes(1)
    expect(d.ensureBackendReadiness).toHaveBeenCalledWith('Qwen3-9B', 'bge', 8192, '--jinja')
    expect(d.notifyHomeAgentUpstreamReady).toHaveBeenCalledWith('http://127.0.0.1:39100')
    expect(lastChatBackendLoadForTest()).toEqual(loadArgs)
  })

  it('does not remember a failed load', async () => {
    const ensureBackendReadiness = vi.fn(async () => {
      throw new Error('OOM')
    })
    wire({
      getService: () => ({
        ensureBackendReadiness,
        baseUrl: 'http://127.0.0.1:39100',
      }),
    })
    await expect(ensureChatBackendReady(loadArgs)).rejects.toThrow('OOM')
    expect(lastChatBackendLoadForTest()).toBeNull()
    await reloadLastChatBackend()
    expect(ensureBackendReadiness).toHaveBeenCalledTimes(1)
  })

  it('reload is a no-op when nothing has been loaded', async () => {
    const d = wire()
    await reloadLastChatBackend()
    expect(d.getService).not.toHaveBeenCalled()
    expect(d.ensureBackendReadiness).not.toHaveBeenCalled()
  })

  it('reload skips GPU admission and reuses the last successful args', async () => {
    const d = wire()
    await ensureChatBackendReady(loadArgs)
    d.awaitChatWindow.mockClear()
    d.stopOvmsImageServer.mockClear()
    d.ensureBackendReadiness.mockClear()

    await reloadLastChatBackend()

    expect(d.awaitChatWindow).not.toHaveBeenCalled()
    expect(d.stopOvmsImageServer).not.toHaveBeenCalled()
    expect(d.ensureBackendReadiness).toHaveBeenCalledWith('Qwen3-9B', 'bge', 8192, '--jinja')
  })

  it('skipGpuAdmission skips the wait on an explicit ensure too', async () => {
    const d = wire()
    await ensureChatBackendReady(loadArgs, { skipGpuAdmission: true })
    expect(d.awaitChatWindow).not.toHaveBeenCalled()
    expect(d.stopOvmsImageServer).not.toHaveBeenCalled()
    expect(d.ensureBackendReadiness).toHaveBeenCalledTimes(1)
  })

  it('continues the load if stopping the OVMS image server fails', async () => {
    const d = wire({
      stopOvmsImageServer: vi.fn(async () => {
        throw new Error('already down')
      }),
    })
    await ensureChatBackendReady(loadArgs)
    expect(d.ensureBackendReadiness).toHaveBeenCalledTimes(1)
    expect(lastChatBackendLoadForTest()?.llmModelName).toBe('Qwen3-9B')
  })

  it('throws before loading when the service is missing', async () => {
    const d = wire({ getService: () => undefined })
    await expect(ensureChatBackendReady(loadArgs)).rejects.toThrow('not found')
    expect(d.awaitChatWindow).not.toHaveBeenCalled()
  })

  it('does not admit the GPU for a non-chat service', async () => {
    const d = wire()
    await ensureChatBackendReady({
      serviceName: 'comfyui-backend',
      llmModelName: 'unused',
    })
    expect(d.awaitChatWindow).not.toHaveBeenCalled()
    expect(d.ensureBackendReadiness).toHaveBeenCalledTimes(1)
  })

  it('remember: false loads without replacing the swap-back snapshot', async () => {
    const d = wire()
    await ensureChatBackendReady(loadArgs)
    d.ensureBackendReadiness.mockClear()

    await ensureChatBackendReady(
      { ...loadArgs, llmModelName: 'home-agent-model' },
      { remember: false },
    )

    expect(d.ensureBackendReadiness).toHaveBeenCalledWith(
      'home-agent-model',
      'bge',
      8192,
      '--jinja',
    )
    expect(lastChatBackendLoadForTest()?.llmModelName).toBe('Qwen3-9B')
  })

  it('reload is a no-op while last-load is disarmed, then resumes the snapshot', async () => {
    const d = wire()
    await ensureChatBackendReady(loadArgs)
    setLastChatBackendLoadActive(false)
    expect(lastChatBackendLoadActiveForTest()).toBe(false)
    d.ensureBackendReadiness.mockClear()

    await reloadLastChatBackend()
    expect(d.ensureBackendReadiness).not.toHaveBeenCalled()
    expect(lastChatBackendLoadForTest()?.llmModelName).toBe('Qwen3-9B')

    setLastChatBackendLoadActive(true)
    await reloadLastChatBackend()
    expect(d.ensureBackendReadiness).toHaveBeenCalledWith('Qwen3-9B', 'bge', 8192, '--jinja')
  })

  it('a remembered load re-arms swap-back after a cloud disarm', async () => {
    const d = wire()
    await ensureChatBackendReady(loadArgs)
    setLastChatBackendLoadActive(false)
    d.ensureBackendReadiness.mockClear()

    await ensureChatBackendReady({ ...loadArgs, llmModelName: 'LFM2.5' })

    expect(lastChatBackendLoadActiveForTest()).toBe(true)
    expect(lastChatBackendLoadForTest()?.llmModelName).toBe('LFM2.5')
    d.awaitChatWindow.mockClear()
    d.ensureBackendReadiness.mockClear()
    await reloadLastChatBackend()
    expect(d.awaitChatWindow).not.toHaveBeenCalled()
    expect(d.ensureBackendReadiness).toHaveBeenCalledWith('LFM2.5', 'bge', 8192, '--jinja')
  })
})
