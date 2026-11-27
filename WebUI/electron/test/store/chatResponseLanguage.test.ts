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

// Mutable per-test inference state: the delivery test at the bottom flips the
// tool-calling and tool-enablement fields without re-mocking the module.
const inference = vi.hoisted(() => ({
  systemPrompt: 'You are helpful.',
  backend: 'cloud',
  activeModel: 'test-model',
  modelSupportsToolCalling: false,
  modelSupportsVision: false,
  aipgToolsEnabled: true,
  toolDelegationEnabled: true,
  isBuiltinToolEnabled: (_name: string): boolean => true,
  screenshotWindow: null,
  mcpToolsEnabled: false,
  mcpServerIds: [] as string[],
  ensureGlobalsMatchConversation: vi.fn(),
  stampMetaForConversation: vi.fn(),
  checkModelAvailability: vi.fn(async () => {}),
  startBackendPreparation: vi.fn(),
  completeBackendPreparation: vi.fn(),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => inference,
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
  inference.modelSupportsToolCalling = false
  inference.modelSupportsVision = false
  inference.aipgToolsEnabled = true
  inference.toolDelegationEnabled = true
  inference.isBuiltinToolEnabled = (_name: string): boolean => true
  inference.screenshotWindow = null
  inference.mcpToolsEnabled = false
  inference.mcpServerIds = []
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
    expect(submitted[1].systemPrompt).toContain('You are helpful.')
    expect(submitted[1].systemPrompt).not.toContain(REPLY_LANGUAGE)
  })

  it('is left out with Chat Aware off', async () => {
    useChatAware().enabled = false
    const chat = useOpenAiCompatibleChat()

    await chat.generate('hi')

    expect(submitted[0].systemPrompt).toContain('You are helpful.')
    expect(submitted[0].systemPrompt).not.toContain(REPLY_LANGUAGE)
  })
})

describe('the tool-availability block on a chat turn', () => {
  it('tells the model a disabled tool exists and where the user can enable it', async () => {
    inference.modelSupportsToolCalling = true
    inference.isBuiltinToolEnabled = (name: string) =>
      name !== 'comfyUI' && name !== 'comfyUiImageEdit'
    const chat = useOpenAiCompatibleChat()

    await chat.generate('hi')

    const prompt = submitted[0].systemPrompt ?? ''
    expect(prompt).toContain('Tool availability:')
    // The directive a weak model must not miss.
    expect(prompt).toContain('do not just say you cannot do it')
    // The disabled tool, spelled out with its enable location.
    expect(prompt).toContain('Media generation')
    expect(prompt).toContain("enable it in the preset's Built-in tools settings")
  })

  it('names the tools the app supports when the model cannot call tools at all', async () => {
    const chat = useOpenAiCompatibleChat()

    await chat.generate('hi')

    const prompt = submitted[0].systemPrompt ?? ''
    expect(prompt).toContain('does not support tool calling')
    expect(prompt).toContain('media generation')
    expect(prompt).toContain('tell them the app supports it')
  })
})
