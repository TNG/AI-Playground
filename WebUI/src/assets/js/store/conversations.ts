import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watchEffect } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { AipgUiMessage } from './openAiCompatibleChat'

/**
 * Legacy fixed key for the original singleton Telegram thread. Kept only as a
 * migration token: at hydrate time we backfill `conversationThreadMeta` for it
 * so it shows up as a normal Home Agent thread alongside any newly created
 * remote conversations. Do NOT use this in new code — addressing happens via
 * `homeAgent.activeRemoteConversationKey` and `conversationThreadMeta`.
 */
export const HOME_AGENT_CONVERSATION_KEY = '__aipg_home_agent__'

export const HOME_AGENT_CONVERSATION_TITLE = 'Home Agent'

/**
 * Logical chat preset id for Home Agent inference. Lives in
 * `modes/base/presets/home-agent-chat.json`. Surfaces in the standard chat
 * preset picker: selecting it from `SettingsChat` jumps to the most recent
 * Home Agent conversation; selecting another preset off a Home Agent thread
 * spawns a fresh main conversation.
 */
export const HOME_AGENT_CHAT_PRESET_NAME = 'Home Agent'

export type ThreadKind = 'main' | 'homeAgent'

/**
 * Per-conversation inference profile snapshot. Stamped on every outbound
 * generate/regenerate so the thread is reproducible and "revisit = reactivate"
 * works in the Chat UI.
 */
export type ConversationThreadMeta = {
  presetName: string
  variant?: string | null
  kind?: ThreadKind
}

export type CreateConversationOptions = {
  kind?: ThreadKind
  presetName?: string
  variant?: string | null
}

export const useConversations = defineStore(
  'conversations',
  () => {
    const conversationList = ref<Record<string, AipgUiMessage[]>>({})
    const conversationThreadMeta = ref<Record<string, ConversationThreadMeta>>({})
    const activeKey = ref('')
    const activeConversation = computed(() => conversationList.value[activeKey.value])

    function updateConversation(messages: AipgUiMessage[], conversationKey: string) {
      conversationList.value[conversationKey] = messages
    }

    function deleteConversation(conversationKey: string) {
      delete conversationList.value[conversationKey]
      delete conversationThreadMeta.value[conversationKey]
    }

    function clearConversation(conversationKey: string) {
      conversationList.value[conversationKey] = []
    }

    function renameConversationTitle(conversationKey: string, newTitle: string) {
      const conversation = conversationList.value[conversationKey]
      if (!conversation || conversation.length === 0) return
      const firstMessage = conversation[0]
      firstMessage.metadata = {
        ...firstMessage.metadata,
        conversationTitle: newTitle,
      }
    }

    function ensureConversationBucket(conversationKey: string) {
      if (!(conversationKey in conversationList.value)) {
        conversationList.value[conversationKey] = []
      }
    }

    function setThreadMeta(conversationKey: string, meta: ConversationThreadMeta) {
      conversationThreadMeta.value[conversationKey] = {
        ...conversationThreadMeta.value[conversationKey],
        ...meta,
      }
    }

    function getThreadMeta(conversationKey: string): ConversationThreadMeta | undefined {
      return conversationThreadMeta.value[conversationKey]
    }

    function getThreadKind(conversationKey: string): ThreadKind {
      return conversationThreadMeta.value[conversationKey]?.kind ?? 'main'
    }

    /**
     * Allocate a new conversation bucket and (optionally) seed thread metadata.
     * Returns the new conversation key. Used by both the main Chat "+" flow
     * and the Home Agent /new command.
     */
    function createConversation(options: CreateConversationOptions = {}): string {
      const newKey = new Date().getTime().toString()
      conversationList.value[newKey] = []
      if (options.presetName || options.kind) {
        conversationThreadMeta.value[newKey] = {
          presetName: options.presetName ?? '',
          variant: options.variant ?? null,
          kind: options.kind ?? 'main',
        }
      }
      return newKey
    }

    function addNewConversation() {
      const list = conversationList.value
      const newKey = addNewConversationIfLatestIsNotEmpty(list)
      activeKey.value = newKey
      return newKey
    }

    const isNewConversation = (key: string) => conversationList.value[key].length === 0

    watchEffect(() => {
      if (Object.keys(conversationList.value).includes(activeKey.value)) return
      const latestConversationKey = Object.keys(conversationList.value).at(-1)
      if (!latestConversationKey) return
      activeKey.value = latestConversationKey
    })

    return {
      conversationList,
      conversationThreadMeta,
      activeKey,
      activeConversation,
      deleteConversation,
      clearConversation,
      isNewConversation,
      updateConversation,
      renameConversationTitle,
      ensureConversationBucket,
      setThreadMeta,
      getThreadMeta,
      getThreadKind,
      createConversation,
      addNewConversation,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['conversationList', 'conversationThreadMeta'],
      afterHydrate: (ctx) => {
        addNewConversationIfLatestIsNotEmpty(ctx.store.$state.conversationList)
        backfillLegacyHomeAgentThreadMeta(
          ctx.store.$state.conversationList,
          ctx.store.$state.conversationThreadMeta,
        )
      },
    },
  },
)

function addNewConversationIfLatestIsNotEmpty(
  list: Record<string, AipgUiMessage[]>,
  conversationKey?: string,
): string {
  console.log('Checking if new conversation is needed', { list, conversationKey })

  const lastKey = Object.keys(list).at(-1)
  if (lastKey && list[lastKey].length === 0) {
    return lastKey
  }

  const newKey = new Date().getTime().toString()
  list[newKey] = []
  return newKey
}

/**
 * Migrate the legacy singleton Home Agent thread to the new metadata model so
 * it shows up via `/history` and the desktop history list as a normal Home
 * Agent conversation.
 */
function backfillLegacyHomeAgentThreadMeta(
  list: Record<string, AipgUiMessage[]>,
  meta: Record<string, ConversationThreadMeta>,
) {
  if (!list[HOME_AGENT_CONVERSATION_KEY]) return
  if (meta[HOME_AGENT_CONVERSATION_KEY]?.kind === 'homeAgent') return
  meta[HOME_AGENT_CONVERSATION_KEY] = {
    ...meta[HOME_AGENT_CONVERSATION_KEY],
    presetName: HOME_AGENT_CHAT_PRESET_NAME,
    variant: null,
    kind: 'homeAgent',
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConversations, import.meta.hot))
}
