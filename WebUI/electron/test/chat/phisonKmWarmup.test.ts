import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const ensureChatBackendReady = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../chat/chatReadiness.ts', () => ({ ensureChatBackendReady }))

const llmServerBaseUrl = vi.hoisted(() => vi.fn(() => 'http://127.0.0.1:39100'))
vi.mock('../../adapters/llmServerSnapshot.ts', () => ({ llmServerBaseUrl }))

vi.mock('../../artifact/runner', () => ({
  artifactRunActive: () => false,
  cancelActiveArtifactRun: () => {},
  activeArtifactRunId: () => null,
  startArtifactRun: async () => ({ state: 'completed', items: [] }),
}))

const orchestrator = await import('../../kernel/orchestrator')
const submitTextRequest = vi.spyOn(orchestrator, 'submitTextRequest')
const finishTextRequest = vi.spyOn(orchestrator, 'finishTextRequest')
const { cancelKmDocumentWarmup, warmupKmDocument } = await import('../../chat/phisonKmWarmup')

const readiness = { serviceName: 'llamacpp-backend', llmModelName: 'gemma-4' }
const request = {
  groups: [{ groupId: 'g0', content: 'policy text' }],
  modelId: 'gemma-4',
  chatTemplateKwargs: { enable_thinking: true },
  readiness,
}

describe('Phison KM document warmup in main', () => {
  beforeEach(() => {
    ensureChatBackendReady.mockClear()
    submitTextRequest.mockClear()
    finishTextRequest.mockClear()
    llmServerBaseUrl.mockClear()
    orchestrator.resetOrchestratorForTest()
  })

  it('takes the Turn Queue place, loads the model, then hands the worker the live server', async () => {
    const prefill = vi.fn(async () => ({ success: true as const }))

    await expect(warmupKmDocument(request, prefill)).resolves.toEqual({ success: true })

    expect(submitTextRequest).toHaveBeenCalledWith(
      expect.objectContaining({ needsGpu: true, joinsTurnQueue: true }),
      expect.any(AbortSignal),
    )
    expect(ensureChatBackendReady).toHaveBeenCalledWith(readiness, { skipGpuAdmission: true })
    expect(prefill).toHaveBeenCalledWith({
      groups: request.groups,
      modelId: 'gemma-4',
      chatTemplateKwargs: { enable_thinking: true },
      llmBackendUrl: 'http://127.0.0.1:39100',
    })
    expect(finishTextRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects with the worker error and still frees the place', async () => {
    const prefill = vi.fn(async () => ({ success: false as const, error: 'HTTP 503' }))

    await expect(warmupKmDocument(request, prefill)).rejects.toThrow('HTTP 503')
    expect(finishTextRequest).toHaveBeenCalledTimes(1)
  })

  it('rejects when no LLM server is running after the load', async () => {
    llmServerBaseUrl.mockReturnValueOnce(undefined as unknown as string)
    const prefill = vi.fn()

    await expect(warmupKmDocument(request, prefill)).rejects.toThrow('not running')
    expect(prefill).not.toHaveBeenCalled()
    expect(finishTextRequest).toHaveBeenCalledTimes(1)
  })

  it('cancelling aborts the prefill in flight', async () => {
    let failPrefill!: () => void
    const prefill = vi.fn(
      () =>
        new Promise<{ success: false; error: string }>(
          (resolve) => (failPrefill = () => resolve({ success: false, error: 'Warmup cancelled' })),
        ),
    )
    const warming = warmupKmDocument(request, prefill)
    await vi.waitFor(() => expect(prefill).toHaveBeenCalled())

    const abortPrefill = vi.fn(async () => failPrefill())
    await expect(cancelKmDocumentWarmup(abortPrefill)).resolves.toEqual({ success: true })

    expect(abortPrefill).toHaveBeenCalledTimes(1)
    await expect(warming).rejects.toThrow('cancelled')
    expect(finishTextRequest).toHaveBeenCalledTimes(1)
  })

  it('cancelling while the model loads skips the prefill', async () => {
    let finishLoad!: () => void
    ensureChatBackendReady.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishLoad = resolve)),
    )
    const prefill = vi.fn()
    const warming = warmupKmDocument(request, prefill)
    await vi.waitFor(() => expect(finishLoad).toBeTypeOf('function'))

    await cancelKmDocumentWarmup(async () => {})
    finishLoad()

    await expect(warming).rejects.toThrow('cancelled')
    expect(prefill).not.toHaveBeenCalled()
  })

  it('cancelling while queued behind a turn leaves at once, loading nothing', async () => {
    await orchestrator.submitTextRequest({
      runId: 'chat-turn',
      conversationKey: 'chat',
      needsGpu: false,
      joinsTurnQueue: true,
    })
    const prefill = vi.fn()
    const warming = warmupKmDocument(request, prefill)
    await vi.waitFor(() => expect(submitTextRequest).toHaveBeenCalledTimes(2))

    await cancelKmDocumentWarmup(async () => {})

    await expect(warming).rejects.toThrow()
    expect(ensureChatBackendReady).not.toHaveBeenCalled()
    expect(prefill).not.toHaveBeenCalled()
    orchestrator.finishTextRequest('chat-turn')
  })

  it('cancelling with nothing in flight does nothing', async () => {
    const abortPrefill = vi.fn()
    await expect(cancelKmDocumentWarmup(abortPrefill)).resolves.toEqual({ success: true })
    expect(abortPrefill).not.toHaveBeenCalled()
  })
})
