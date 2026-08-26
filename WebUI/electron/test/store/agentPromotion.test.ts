import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ref } from 'vue'
import type { ChatPreset } from '@/assets/js/store/presets'

/** Shape of an `agentMode:executeTool` dispatch (`AgentToolExecuteRequest`). */
type ToolCall = {
  requestId: string
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

// Quick Coder writes a game once and cannot revise it, so it can offer to hand
// the game to Game Agent. What these tests cover is that whole path: the tool
// call arriving from the main process, the card the user answers, and the
// session ending up under the preset that can work on what was written.

const QUICK_CODER: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Quick Coder',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'games',
  agentCapabilities: ['game-studio-quick'],
} as ChatPreset

const GAME_AGENT: ChatPreset = {
  type: 'chat',
  category: 'chat',
  name: 'Game Agent',
  backends: ['llamaCPP'],
  agentPreset: true,
  agentWorkspace: 'games',
  agentCapabilities: ['media', 'web-debug', 'game-studio'],
} as ChatPreset

const activePreset = ref<ChatPreset>(QUICK_CODER)

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: [QUICK_CODER, GAME_AGENT],
    get activePresetWithVariant() {
      return activePreset.value
    },
  }),
}))

const switchPreset = vi.fn(async (name: string) => {
  const preset = [QUICK_CODER, GAME_AGENT].find((entry) => entry.name === name)
  if (preset) activePreset.value = preset
  return { success: true }
})

vi.mock('@/assets/js/store/presetSwitching', () => ({
  usePresetSwitching: () => ({ switchPreset }),
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({ backend: 'llamaCPP', ensureReadyForInference: vi.fn() }),
}))

vi.mock('@/assets/js/store/cloudMode', () => ({
  useCloudMode: () => ({}),
  CLOUD_DEFAULT_MODEL: 'test-model',
}))

vi.mock('@/assets/js/store/errors', () => ({
  useErrors: () => ({ report: vi.fn() }),
}))

// The media bridge must never see this tool: it is a question for the user, and
// the media lane it would queue on is busy with work waiting on the answer.
const executeAgentTool = vi.fn()

vi.mock('@/assets/js/tools/agentBridge', () => ({
  executeAgentTool,
  getAgentToolSpecs: () => [],
}))

vi.mock('@ai-sdk/vue', () => ({
  Chat: class {
    messages: unknown[] = []
    error = undefined
    sendMessage = vi.fn()
    stop = vi.fn()
  },
}))

const submitToolResult = vi.fn(async () => {})
let dispatchTool: ((request: ToolCall) => void | Promise<void>) | undefined

globalThis.window = {
  electronAPI: {
    agentMode: {
      cancel: vi.fn(async () => {}),
      deleteSession: vi.fn(async () => ({ success: true })),
      submitToolResult,
      onStreamChunk: vi.fn(),
      onToolProgress: vi.fn(),
      onToolImage: vi.fn(),
      onTurnDone: vi.fn(),
      // The store registers its handlers once per module, so the dispatch used
      // by every test below is the one captured here.
      onExecuteTool: vi.fn((handler) => {
        dispatchTool = handler
        return () => {}
      }),
    },
    games: { read: vi.fn(async () => null), list: vi.fn(async () => []) },
  },
} as unknown as Window & typeof globalThis

const { useAgentMode } = await import('@/assets/js/store/agentMode')
const { useConfirmations } = await import('@/assets/js/store/confirmations')

type Store = ReturnType<typeof useAgentMode>

// One store for the file: the IPC handlers are registered once, so a store from
// a second Pinia would never receive a tool call.
let store: Store
let confirmations: ReturnType<typeof useConfirmations>

beforeAll(() => {
  setActivePinia(createPinia())
  store = useAgentMode()
  confirmations = useConfirmations()
})

function seedQuickCoderGame(): void {
  store.sessions = {
    'qc-1': {
      id: 'qc-1',
      workspaceDir: '/games/space-dodger',
      title: 'dodge asteroids',
      messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'dodge asteroids' }] }],
      createdAt: 1,
      updatedAt: 2,
      presetName: 'Quick Coder',
      capabilities: ['game-studio-quick'],
    },
  }
  store.activeSessionId = 'qc-1'
  store.workspaceDir = '/games/space-dodger'
}

/** Answer the offer the tool call put up, once it exists. */
async function answerOffer(accept: boolean): Promise<void> {
  await vi.waitFor(() => expect(confirmations.items).toHaveLength(1))
  confirmations.resolve(confirmations.items[0].id, accept)
}

beforeEach(() => {
  activePreset.value = QUICK_CODER
  switchPreset.mockClear()
  submitToolResult.mockClear()
  executeAgentTool.mockClear()
  seedQuickCoderGame()
})

describe('offering the switch to Game Agent', () => {
  it('moves the session to Game Agent when the user accepts', async () => {
    const dispatched = dispatchTool?.({
      requestId: 'req-1',
      toolCallId: 'call-1',
      toolName: 'offerGameAgent',
      input: { reason: 'the ship keeps moving after you let go' },
    })

    await answerOffer(true)
    await dispatched

    expect(switchPreset).toHaveBeenCalledWith('Game Agent', { skipMemoryAlert: true })
    // Same conversation and folder, under the preset that can change the game.
    expect(store.sessions['qc-1'].presetName).toBe('Game Agent')
    expect(store.sessions['qc-1'].capabilities).toEqual(['media', 'web-debug', 'game-studio'])
    expect(store.sessions['qc-1'].workspaceDir).toBe('/games/space-dodger')
    expect(store.activeSessionId).toBe('qc-1')
    // The turn's remaining steps have to know they are no longer the ones
    // writing the game.
    expect(submitToolResult).toHaveBeenCalledWith(
      'req-1',
      expect.objectContaining({ accepted: true }),
    )
    expect(executeAgentTool).not.toHaveBeenCalled()
  })

  it('leaves the session where it is when the user declines', async () => {
    const dispatched = dispatchTool?.({
      requestId: 'req-2',
      toolCallId: 'call-2',
      toolName: 'offerGameAgent',
      input: { reason: 'make the rocks faster' },
    })

    await answerOffer(false)
    await dispatched

    expect(switchPreset).not.toHaveBeenCalled()
    expect(store.sessions['qc-1'].presetName).toBe('Quick Coder')
    expect(submitToolResult).toHaveBeenCalledWith(
      'req-2',
      expect.objectContaining({ accepted: false }),
    )
  })

  // Otherwise a question the user can no longer answer would sit in the
  // transcript, and the tool waiting on it would never return.
  it('declines an unanswered offer when the turn ends', async () => {
    // A tool only runs inside a turn, and it is that turn ending which has to
    // settle the card.
    store.processing = true
    const dispatched = dispatchTool?.({
      requestId: 'req-3',
      toolCallId: 'call-3',
      toolName: 'offerGameAgent',
      input: { reason: 'add a boss' },
    })

    await vi.waitFor(() => expect(confirmations.items).toHaveLength(1))
    await store.stop()
    await dispatched

    expect(confirmations.items).toHaveLength(0)
    expect(store.sessions['qc-1'].presetName).toBe('Quick Coder')
  })
})

describe('promoteToGameAgent', () => {
  it('is offered while Quick Coder holds a game, and not afterwards', async () => {
    store.currentGame = { dir: '/games/space-dodger', name: 'Space Dodger' } as never
    expect(store.canPromoteToGameAgent).toBe(true)

    expect(await store.promoteToGameAgent()).toBe(true)
    expect(store.canPromoteToGameAgent).toBe(false)
  })

  it('has nothing to offer before a game exists', () => {
    store.currentGame = null
    expect(store.canPromoteToGameAgent).toBe(false)
  })
})
