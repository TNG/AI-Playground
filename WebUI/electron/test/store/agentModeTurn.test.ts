import { describe, expect, it, vi } from 'vitest'
import { buildTurnConfig } from '@/assets/js/store/agentModeTurn'

vi.mock('@/assets/js/tools/agentBridge', () => ({
  getAgentToolSpecs: () => [],
  executeAgentTool: vi.fn(),
}))

vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => ({ keepModelsLoaded: false }),
}))

vi.mock('@/assets/js/store/agentModeIpc', () => ({
  registerAgentModeIpc: vi.fn(),
}))

function localInference(overrides: Record<string, unknown> = {}) {
  return {
    samplingRequestBody: {},
    temperature: 0.7,
    modelSupportsThinkingToggle: false,
    thinkingEnabled: false,
    thinkingActive: false,
    backend: 'llamaCPP',
    activeModel: 'Qwen3-9B',
    localBackendUrl: 'http://127.0.0.1:39000',
    modelSupportsVision: false,
    effectiveContextWindow: 32768,
    getCurrentDeviceId: () => 'GPU.0',
    getCurrentDeviceName: () => 'Intel Arc',
    contextSize: 8192,
    activeLlmModel: { llamaCppArgs: '--jinja' },
    ...overrides,
  }
}

describe('buildTurnConfig readiness (step 15)', () => {
  it('ships local backend load facts so main can occupy and load', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      workspaceDir: '/tmp/ws',
      presetName: 'Agent',
      instructions: 'Be helpful.',
      capabilities: [],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference() as never,
      cloudMode: {
        ensureProxyUrl: async () => 'http://proxy',
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.readiness).toEqual({
      serviceName: 'llamacpp-backend',
      llmModelName: 'Qwen3-9B',
      contextSize: 8192,
      modelArgs: '--jinja',
    })
  })

  it('omits readiness when no local model is selected', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      workspaceDir: '/tmp/ws',
      presetName: 'Agent',
      instructions: '',
      capabilities: [],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference({ activeModel: null }) as never,
      cloudMode: {
        ensureProxyUrl: async () => 'http://proxy',
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.readiness).toBeUndefined()
  })

  it('does not ship readiness for a cloud turn', async () => {
    const config = await buildTurnConfig({
      sessionId: 'aipg-agent-1',
      workspaceDir: '/tmp/ws',
      presetName: 'Agent',
      instructions: '',
      capabilities: [],
      unsandboxed: false,
      planningThinkingOnly: false,
      textInference: localInference({
        backend: 'cloud',
        activeModel: 'gpt-test',
        localBackendUrl: null,
      }) as never,
      cloudMode: {
        activeProviderBaseUrl: 'https://api.openai.com',
        ensureProxyUrl: async () => 'http://127.0.0.1:9/v1',
        selectedProviderId: 'openai',
        activeProviderAuthStyle: 'bearer',
        capabilitiesFor: () => ({ reasoningAdvertised: false }),
      },
    })
    expect(config.modelConfig.source).toBe('cloud')
    expect(config.readiness).toBeUndefined()
  })
})
