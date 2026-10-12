import { describe, expect, it } from 'vitest'
import {
  resolveTaskEmbedding,
  resolveTaskModel,
  taskModelSupportsThinkingToggle,
  type TaskModelEnvironment,
} from '@/lib/agentTaskModel'
import { AgentTaskSchema, migrateAgentTaskDoc } from '@/types/agentMakerIpc'

const QWEN = 'unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf'

function env(overrides: Partial<TaskModelEnvironment> = {}): TaskModelEnvironment {
  return {
    catalog: [
      {
        name: QWEN,
        type: 'llamaCPP',
        supportsThinkingToggle: true,
        maxContextSize: 65536,
        llamaCppArgs: '--spec-type draft-mtp',
        inferenceDefaults: { temperature: 0.6, topP: 0.95, thinking: { temperature: 1.0 } },
      },
      { name: 'OpenVINO/Qwen3-8B-int4-ov', type: 'openVINO', maxContextSize: 40960 },
    ],
    services: [
      {
        serviceName: 'llamacpp-backend',
        baseUrl: 'http://127.0.0.1:39000',
        devices: [{ id: '0', name: 'Intel Arc B580', selected: true }],
      },
      {
        serviceName: 'openvino-backend',
        baseUrl: 'http://127.0.0.1:29000',
        devices: [{ id: 'GPU.0', name: 'Intel Arc', selected: true }],
      },
    ],
    cloudProviders: [
      {
        id: 'openrouter',
        name: 'OpenRouter',
        baseUrl: 'https://openrouter.ai/api/v1/',
        modelCapabilities: { 'gpt-x': { reasoningAdvertised: true, contextLength: 128000 } },
      },
    ],
    cloudProxyUrl: 'http://127.0.0.1:5000',
    ...overrides,
  }
}

describe('resolveTaskModel', () => {
  it('resolves a local task from the live catalog and service, not from stored URLs', () => {
    const resolved = resolveTaskModel(
      { backend: 'llamaCPP', model: QWEN, contextSize: 131072, thinkingEnabled: false },
      env(),
    )
    expect(resolved.modelConfig).toMatchObject({
      source: 'local',
      model: QWEN.split('/').join('---'),
      backend: 'llamaCPP',
      baseUrl: 'http://127.0.0.1:39000/v1',
      deviceName: 'Intel Arc B580',
      contextWindow: 65536,
    })
    expect(resolved.readiness).toEqual({
      serviceName: 'llamacpp-backend',
      llmModelName: QWEN,
      contextSize: 65536,
      modelArgs: '--spec-type draft-mtp',
    })
    const sampling = (resolved.modelConfig as { samplingParams: Record<string, unknown> })
      .samplingParams
    expect(sampling.temperature).toBe(0.6)
    expect(sampling.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(resolved.planningThinkingOnly).toBe(false)
  })

  it('uses the thinking profile and planning switch when the task thinks', () => {
    const resolved = resolveTaskModel({ backend: 'llamaCPP', model: QWEN }, env())
    const sampling = (resolved.modelConfig as { samplingParams: Record<string, unknown> })
      .samplingParams
    expect(sampling.temperature).toBe(1.0)
    expect(resolved.planningThinkingOnly).toBe(true)
  })

  it('reports OpenVINO on GPU with the model ceiling and passes no llama flags', () => {
    const resolved = resolveTaskModel(
      { backend: 'openVINO', model: 'OpenVINO/Qwen3-8B-int4-ov', contextSize: 8192 },
      env(),
    )
    expect(resolved.modelConfig.contextWindow).toBe(40960)
    expect(resolved.readiness?.modelArgs).toBeUndefined()
  })

  it('resolves a cloud task against its own provider', () => {
    const resolved = resolveTaskModel(
      { backend: 'cloud', model: 'gpt-x', providerId: 'openrouter' },
      env(),
    )
    expect(resolved.modelConfig).toMatchObject({
      source: 'cloud',
      proxyBaseUrl: 'http://127.0.0.1:5000',
      upstreamBaseUrl: 'https://openrouter.ai/api',
      providerId: 'openrouter',
      reasoningAdvertised: true,
      contextWindow: 128000,
    })
    expect(resolved.readiness).toBeUndefined()
  })

  it('fails clearly when the model or provider is gone', () => {
    expect(() => resolveTaskModel({ backend: 'llamaCPP', model: 'missing' }, env())).toThrow(
      /no longer available/,
    )
    expect(() =>
      resolveTaskModel({ backend: 'cloud', model: 'gpt-x', providerId: 'gone' }, env()),
    ).toThrow(/provider/)
  })

  it('offers the thinking switch only for local models that support it', () => {
    expect(
      taskModelSupportsThinkingToggle({ backend: 'llamaCPP', model: QWEN }, env().catalog),
    ).toBe(true)
    expect(
      taskModelSupportsThinkingToggle(
        { backend: 'openVINO', model: 'OpenVINO/Qwen3-8B-int4-ov' },
        env().catalog,
      ),
    ).toBe(false)
  })
})

describe('resolveTaskEmbedding', () => {
  const embeddingModels = [
    { name: 'BAAI/bge-m3', type: 'llamaCPP', downloaded: true },
    { name: 'OpenVINO/bge-ov', type: 'openVINO', downloaded: false },
  ]

  it('is empty unless the task has rag and an embedding model', () => {
    const model = { backend: 'llamaCPP' as const, model: QWEN, embeddingModel: 'BAAI/bge-m3' }
    expect(resolveTaskEmbedding(model, ['media'], { embeddingModels })).toEqual({})
    expect(
      resolveTaskEmbedding({ backend: 'llamaCPP', model: QWEN }, ['rag'], { embeddingModels }),
    ).toEqual({})
  })

  it('loads a downloaded embedding model with the LLM on the same backend', () => {
    const resolved = resolveTaskEmbedding(
      {
        backend: 'llamaCPP',
        model: QWEN,
        embeddingModel: 'BAAI/bge-m3',
        embeddingBackend: 'llamaCPP',
      },
      ['rag'],
      { embeddingModels },
    )
    expect(resolved).toEqual({
      embeddingModel: 'BAAI/bge-m3',
      embeddingBackend: 'llamaCPP',
      readinessEmbeddingModel: 'BAAI/bge-m3',
    })
  })

  it('leaves a missing or other-backend model to the first rag call', () => {
    const missing = resolveTaskEmbedding(
      {
        backend: 'openVINO',
        model: 'x',
        embeddingModel: 'OpenVINO/bge-ov',
        embeddingBackend: 'openVINO',
      },
      ['rag'],
      { embeddingModels },
    )
    expect(missing.readinessEmbeddingModel).toBeUndefined()
    const cloud = resolveTaskEmbedding(
      {
        backend: 'cloud',
        model: 'gpt-x',
        embeddingModel: 'BAAI/bge-m3',
        embeddingBackend: 'llamaCPP',
      },
      ['rag'],
      { embeddingModels },
    )
    expect(cloud).toEqual({ embeddingModel: 'BAAI/bge-m3', embeddingBackend: 'llamaCPP' })
  })
})

describe('migrateAgentTaskDoc', () => {
  it('upgrades a v1 frozen modelConfig to v2 model choices', () => {
    const v1 = {
      schemaVersion: 1,
      id: 'aipg-task-1',
      name: 'T',
      slug: 't',
      steps: ['do it'],
      modelConfig: {
        source: 'local',
        model: QWEN.split('/').join('---'),
        backend: 'llamaCPP',
        baseUrl: 'http://127.0.0.1:39000/v1',
      },
      modelRepoId: QWEN,
      contextSize: 32768,
      llamaCppArgs: '--x',
      capabilities: ['media'],
      presetName: 'Agent',
      createdAt: 1,
      updatedAt: 2,
    }
    const parsed = AgentTaskSchema.parse(migrateAgentTaskDoc(v1))
    expect(parsed.schemaVersion).toBe(3)
    expect(parsed.model).toEqual({ backend: 'llamaCPP', model: QWEN, contextSize: 32768 })
  })

  it('raises a v2 document to v3 without touching its fields', () => {
    expect(migrateAgentTaskDoc({ schemaVersion: 2, id: 'x' })).toEqual({
      schemaVersion: 3,
      id: 'x',
    })
  })

  it('leaves a v3 document untouched', () => {
    const doc = { schemaVersion: 3, id: 'x' }
    expect(migrateAgentTaskDoc(doc)).toBe(doc)
  })
})
