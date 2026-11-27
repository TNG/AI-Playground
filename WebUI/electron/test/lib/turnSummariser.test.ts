import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InferenceForTurn } from '@/lib/storedSessionInference'

// The renderer resolves the Assistant preset's local model for activation, refresh
// and media/audio turns, and the Session's frozen language over the live UI one.

const mock = vi.hoisted(() => ({
  calls: [] as { preset: string; settings: Record<string, unknown> }[],
  inference: {} as InferenceForTurn,
  frozenLanguage: undefined as string | undefined,
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    inferenceForSettings: (preset: string, settings: Record<string, unknown>) => {
      mock.calls.push({ preset, settings })
      return { inference: mock.inference }
    },
  }),
  backendToService: { llamaCPP: 'llamacpp-backend', openVINO: 'openvino-backend' },
}))

vi.mock('@/assets/js/store/sessions', () => ({
  useSessions: () => ({
    openSession: mock.frozenLanguage ? { responseLocale: mock.frozenLanguage } : {},
  }),
}))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'en-US' }),
}))

const { assistantLocalSummariser, summariserLanguage, turnSummariser } =
  await import('@/lib/turnSummariser')

beforeEach(() => {
  mock.calls = []
  mock.frozenLanguage = undefined
  mock.inference = {
    backend: 'llamaCPP',
    activeModel: '/models/qwen.gguf',
    localBackendUrl: 'http://127.0.0.1:39100/v1',
    contextSize: 8192,
    samplingRequestBody: { top_p: 0.9 },
    temperature: 0.4,
    effectiveMaxTokens: 2048,
    modelSupportsVision: true,
    modelSupportsThinkingToggle: true,
    thinkingEnabled: true,
    thinkingActive: true,
    effectiveReasoningEffort: 'low',
    activeLlmModel: { llamaCppArgs: '--spec-type draft-mtp' },
  } as unknown as InferenceForTurn
})

describe('the Assistant preset summariser', () => {
  it('resolves the Assistant preset’s default local model, not the active preset', () => {
    const summariser = assistantLocalSummariser('de')

    expect(mock.calls).toEqual([{ preset: 'Assistant', settings: {} }])
    expect(summariser.language).toBe('de')
    expect(summariser.model).toMatchObject({
      backend: 'llamaCPP',
      modelId: '---models---qwen.gguf',
      baseUrl: 'http://127.0.0.1:39100/v1',
      readiness: {
        serviceName: 'llamacpp-backend',
        llmModelName: '/models/qwen.gguf',
        contextSize: 8192,
        modelArgs: '--spec-type draft-mtp',
      },
      temperature: 0.4,
      maxOutputTokens: 2048,
      supportsVision: true,
    })
  })

  it('sends no model when the Assistant preset is cloud', () => {
    mock.inference = { ...mock.inference, backend: 'cloud' } as unknown as InferenceForTurn

    expect(assistantLocalSummariser('de')).toEqual({ language: 'de' })
  })

  it('uses the Session’s frozen language over the live UI language', () => {
    mock.frozenLanguage = 'ja'

    expect(summariserLanguage()).toBe('ja')
    expect(turnSummariser().language).toBe('ja')
  })
})
