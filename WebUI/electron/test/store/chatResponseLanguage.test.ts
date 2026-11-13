import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { ChatTurnRequest } from '@/types/chatIpc'
import type { KernelEvent } from '@/types/kernelEvents'

// The chat store's half of the reply-language line: what system prompt the turn it submits to
// main carries, with Chat Aware on (the default) and off.

const REPLY_LANGUAGE = 'Use German as the default response language.'

const conversation = vi.hoisted(() => ({
  list: {} as Record<string, unknown[]>,
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    systemPrompt: 'You are helpful.',
    backend: 'cloud',
    activeModel: 'test-model',
    modelSupportsToolCalling: false,
    modelSupportsVision: false,
    mcpToolsEnabled: false,
    ensureGlobalsMatchConversation: vi.fn(),
    stampMetaForConversation: vi.fn(),
    checkModelAvailability: vi.fn(async () => {}),
    startBackendPreparation: vi.fn(),
    completeBackendPreparation: vi.fn(),
  }),
}))

vi.mock('@/assets/js/store/conversations', () => ({
  useConversations: () => ({
    activeKey: 'thread-1',
    get conversationList() {
      return conversation.list
    },
    lastMainKey: 'thread-1',
    ensureConversationBucket: (key: string) => {
      conversation.list[key] ??= []
    },
    applyConversationMessages: vi.fn(),
    getThreadMeta: () => null,
    getThreadRagHashes: () => [],
    init: vi.fn(async () => {}),
  }),
}))

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({ activePresetName: 'Basic Chat', activeVariantName: {} }),
}))

vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report: (e: unknown) => e }) }))

vi.mock('@/assets/js/store/activities', () => ({
  useActivities: () => ({
    track: (_activity: unknown, run: () => unknown) => run(),
    begin: () => 'activity',
    end: vi.fn(),
    endScope: vi.fn(),
  }),
}))

vi.mock('@/assets/js/store/confirmations', () => ({
  useConfirmations: () => ({ cancelForConversation: vi.fn() }),
}))

vi.mock('@/assets/js/store/i18n', () => ({
  useI18N: () => ({ langName: 'de', state: {} }),
}))

vi.mock('@/assets/js/store/developerSettings', () => ({
  useDeveloperSettings: () => ({ keepModelsLoaded: false }),
}))

vi.mock('@/assets/js/store/computeMetrics', () => ({
  useComputeMetrics: () => ({ beginTurn: vi.fn(), endTurn: vi.fn() }),
}))

vi.mock('@/lib/chatModel', () => ({ buildChatModelConfig: () => ({}) }))
vi.mock('@/lib/chatRagRequest', () => ({ buildChatRagRequest: () => undefined }))
vi.mock('@/assets/js/tools/tools', () => ({ aipgTools: {}, sessionTools: {} }))
vi.mock('@/assets/js/tools/comfyUi', () => ({
  getAvailableWorkflows: () => [],
  createToolRepairData: () => null,
}))
vi.mock('@/assets/js/tools/comfyUiImageEdit', () => ({
  getAvailableEditWorkflows: () => [],
  createEditToolRepairData: () => null,
}))
vi.mock('@/assets/js/speech/speechIO', () => ({
  synthesizeToolAvailable: () => false,
  transcriptionAvailable: () => false,
}))

let emit: (event: KernelEvent) => void = () => {}
let seq = 0
const submitted: ChatTurnRequest[] = []

beforeEach(() => {
  setActivePinia(createPinia())
  conversation.list = {}
  submitted.length = 0
  seq = 0
  const storage = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => void storage.set(key, value),
    removeItem: (key: string) => void storage.delete(key),
  } as unknown as Storage
  globalThis.window = {
    electronAPI: {
      chat: {
        submitTurn: vi.fn(async (request: ChatTurnRequest) => {
          submitted.push(request)
          const turnId = `turn-${submitted.length}`
          queueMicrotask(() => finishTurn(request.conversationKey, turnId))
          return { success: true, turnId }
        }),
        resumeTurn: vi.fn(),
        cancelTurn: vi.fn(),
      },
      onKernelEvent: (listener: (event: KernelEvent) => void) => {
        emit = listener
        return () => {}
      },
    },
  } as unknown as Window & typeof globalThis
})

function finishTurn(conversationKey: string, turnId: string): void {
  const scope = { kind: 'chat', conversationKey }
  const chunk = (value: Record<string, unknown>) =>
    emit({ type: 'chat-chunk', conversationKey, turnId, chunk: value, scope, seq: ++seq } as never)
  chunk({ type: 'start' })
  chunk({ type: 'text-start', id: 't' })
  chunk({ type: 'text-delta', id: 't', delta: 'Hallo.' })
  chunk({ type: 'text-end', id: 't' })
  chunk({ type: 'finish' })
  emit({ type: 'chat-turn-done', conversationKey, turnId, scope, seq: ++seq } as never)
}

const { useOpenAiCompatibleChat } = await import('@/assets/js/store/openAiCompatibleChat')
const { useChatAware } = await import('@/assets/js/store/chatAware')

describe('the reply-language line on a chat turn', () => {
  it('is in the system prompt at conversation start, and only there, by default', async () => {
    const chat = useOpenAiCompatibleChat()

    await chat.generate('hi')
    await chat.generate('and again')

    expect(submitted[0].systemPrompt).toContain('You are helpful.')
    expect(submitted[0].systemPrompt).toContain(REPLY_LANGUAGE)
    expect(submitted[1].systemPrompt).toBe('You are helpful.')
  })

  it('is left out with Chat Aware off', async () => {
    useChatAware().enabled = false
    const chat = useOpenAiCompatibleChat()

    await chat.generate('hi')

    expect(submitted[0].systemPrompt).toBe('You are helpful.')
  })
})
