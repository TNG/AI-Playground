import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const generateText = vi.hoisted(() => vi.fn(async () => ({ text: 'hello world extra words' })))
vi.mock('ai', () => ({ generateText }))

const createMainChatModel = vi.hoisted(() => vi.fn(() => ({ id: 'mock-model' })))
vi.mock('../../chat/chatModelMain.ts', () => ({ createMainChatModel }))

const ensureChatBackendReady = vi.hoisted(() => vi.fn(async () => {}))
const setLastChatBackendLoadActive = vi.hoisted(() => vi.fn())
vi.mock('../../chat/chatReadiness.ts', () => ({
  ensureChatBackendReady,
  setLastChatBackendLoadActive,
}))

vi.mock('../../artifact/runner', () => ({
  artifactRunActive: () => false,
  cancelActiveArtifactRun: () => {},
  activeArtifactRunId: () => null,
  startArtifactRun: async () => ({ state: 'completed', items: [] }),
}))

const orchestrator = await import('../../kernel/orchestrator')
const submitTextRequest = vi.spyOn(orchestrator, 'submitTextRequest')
const finishTextRequest = vi.spyOn(orchestrator, 'finishTextRequest')

const { summarizeConversationText } = await import('../../chat/chatSummarize')

const localModel = {
  backend: 'llamaCPP' as const,
  modelId: 'HomeAgent-0.6B',
  readiness: {
    serviceName: 'llamacpp-backend',
    llmModelName: 'HomeAgent-0.6B',
  },
}

describe('chat summarize admit (step 15)', () => {
  beforeEach(() => {
    generateText.mockClear()
    ensureChatBackendReady.mockClear()
    setLastChatBackendLoadActive.mockClear()
    createMainChatModel.mockClear()
    submitTextRequest.mockClear()
    finishTextRequest.mockClear()
    orchestrator.resetOrchestratorForTest()
  })

  it('occupies as text, loads with remember:false, and trims to five words', async () => {
    await expect(
      summarizeConversationText({ messagesText: 'User: hi', model: localModel }),
    ).resolves.toBe('hello world extra words')
    expect(submitTextRequest).toHaveBeenCalledWith({
      runId: expect.stringMatching(/^summarize-/),
      conversationKey: 'home-agent-summarize',
      needsGpu: true,
      joinsTurnQueue: true,
      work: 'summary',
    })
    expect(ensureChatBackendReady).toHaveBeenCalledWith(localModel.readiness, {
      skipGpuAdmission: true,
      remember: false,
      conversationKey: 'home-agent-summarize',
    })
    expect(finishTextRequest).toHaveBeenCalledTimes(1)
    expect(generateText).toHaveBeenCalledTimes(1)
  })

  it('occupies a cloud summary without loading a local backend', async () => {
    await summarizeConversationText({
      messagesText: 'User: hi',
      model: { backend: 'cloud', modelId: 'gpt-test' },
    })
    expect(submitTextRequest).toHaveBeenCalledWith(
      expect.objectContaining({ needsGpu: false, joinsTurnQueue: true }),
    )
    expect(ensureChatBackendReady).not.toHaveBeenCalled()
    expect(setLastChatBackendLoadActive).toHaveBeenCalledWith(false)
    expect(finishTextRequest).toHaveBeenCalledTimes(1)
  })

  it('releases occupancy when the load fails', async () => {
    ensureChatBackendReady.mockRejectedValueOnce(new Error('OOM'))
    await expect(
      summarizeConversationText({ messagesText: 'User: hi', model: localModel }),
    ).rejects.toThrow('OOM')
    expect(finishTextRequest).toHaveBeenCalledTimes(1)
    expect(generateText).not.toHaveBeenCalled()
  })

  it('waits in the Turn Queue behind a running agent turn', async () => {
    await orchestrator.submitTextRequest({
      runId: 'agent-turn',
      conversationKey: 'session-a',
      needsGpu: false,
      joinsTurnQueue: true,
      work: 'agent',
    })
    const summary = summarizeConversationText({ messagesText: 'User: hi', model: localModel })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ensureChatBackendReady).not.toHaveBeenCalled()
    expect(generateText).not.toHaveBeenCalled()

    orchestrator.finishTextRequest('agent-turn')
    await expect(summary).resolves.toBe('hello world extra words')
    expect(ensureChatBackendReady).toHaveBeenCalledTimes(1)
  })
})
