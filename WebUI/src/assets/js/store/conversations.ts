import { acceptHMRUpdate, defineStore } from 'pinia'
import { AipgUiMessage } from './openAiCompatibleChat'

// Regex for base64 data URIs — used in the serializer to strip them from persisted state
const BASE64_DATA_URI_PATTERN = /^data:image\/[^;]+;base64,/

export const useConversations = defineStore(
  'conversations',
  () => {
    const conversationList = ref<Record<string, AipgUiMessage[]>>({})
    const activeKey = ref('')
    const activeConversation = computed(() => conversationList.value[activeKey.value])

    function updateConversation(messages: AipgUiMessage[], conversationKey: string) {
      conversationList.value[conversationKey] = messages
    }

    function deleteConversation(conversationKey: string) {
      delete conversationList.value[conversationKey]
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
      activeKey,
      activeConversation,
      deleteConversation,
      clearConversation,
      isNewConversation,
      updateConversation,
      renameConversationTitle,
      addNewConversation,
    }
  },
  {
    persist: {
      pick: ['conversationList'],
      afterHydrate: (ctx) =>
        addNewConversationIfLatestIsNotEmpty(ctx.store.$state.conversationList),
      serializer: {
        serialize: (state) => {
          return JSON.stringify(state, (_key, value) => {
            if (typeof value === 'string' && BASE64_DATA_URI_PATTERN.test(value)) {
              return ''
            }
            return value
          })
        },
        deserialize: (value) => JSON.parse(value),
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

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConversations, import.meta.hot))
}
