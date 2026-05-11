import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useOpenAiCompatibleChat } from './openAiCompatibleChat'
import * as toast from '../toast'

export const useHomeAgent = defineStore(
  'homeAgent',
  () => {
    const backendServices = useBackendServices()

    const isHomeAgentActive = ref(false)
    const telegramToken = ref<string | null>(null)
    const telegramChatId = ref<string | null>(null)
    const telegramVerified = ref(false)

    let _pollInterval: ReturnType<typeof setInterval> | null = null
    let _processing = false

    // Load token from safeStorage (not persisted to disk for security).
    // telegramChatId and telegramVerified ARE persisted, so they are already
    // populated synchronously before this resolves.
    window.electronAPI.homeAgent.loadConfig().then((cfg) => {
      if (cfg) {
        telegramToken.value = cfg.token
        telegramChatId.value = cfg.chatId
      } else {
        // No config in safeStorage — clear everything only if nothing was persisted
        if (!telegramVerified.value) {
          telegramToken.value = null
          telegramChatId.value = null
          isHomeAgentActive.value = false
        }
      }
    })

    const isTelegramConfigured = computed(
      () => !!telegramToken.value && !!telegramChatId.value,
    )

    // "Ready to activate" = previously verified. telegramVerified is persisted,
    // so this is true immediately on startup if the user verified in a previous run.
    // We do NOT gate on isTelegramConfigured here — that would require the async
    // safeStorage load to complete before the toggle becomes enabled.
    const isReadyToActivate = computed(() => telegramVerified.value)

    const isAvailable = computed(
      () =>
        backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.isSetUp ?? false,
    )

    const homeAgentBaseUrl = computed(
      () => backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.baseUrl,
    )

    // When the backend becomes available and Telegram has been verified, auto-activate.
    watch(isAvailable, (val) => {
      if (val && isReadyToActivate.value) {
        isHomeAgentActive.value = true
      }
      if (!val) {
        isHomeAgentActive.value = false
      }
    })

    // When verification state changes, sync active state.
    watch(isReadyToActivate, (val) => {
      if (!val) {
        isHomeAgentActive.value = false
      } else if (isAvailable.value) {
        isHomeAgentActive.value = true
      }
    })

    // Start/stop Telegram polling when active state changes
    watch(isHomeAgentActive, (val) => {
      if (val) {
        startPolling()
      } else {
        stopPolling()
      }
    })

    async function processTelegramMessages() {
      if (!isHomeAgentActive.value) return
      if (_processing) return
      try {
        const msgs = await window.electronAPI.homeAgent.pollTelegram()
        if (!msgs || msgs.length === 0) return
        _processing = true
        const chatStore = useOpenAiCompatibleChat()
        for (const msg of msgs) {
          try {
            await chatStore.generate(msg.text)
            const allMessages = chatStore.messages
            console.log('[HomeAgent] messages after generate:', allMessages?.length, allMessages?.map(m => m.role))
            if (allMessages && allMessages.length > 0) {
              const last = allMessages[allMessages.length - 1]
              console.log('[HomeAgent] last message role:', last.role, 'parts:', last.parts?.length)
              if (last.role === 'assistant') {
                const replyText = last.parts
                  .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
                  .map((p) => p.text)
                  .join('')
                console.log('[HomeAgent] sending reply to Telegram:', replyText.slice(0, 100))
                if (replyText) {
                  const result = await window.electronAPI.homeAgent.sendTelegramReply(replyText)
                  console.log('[HomeAgent] sendTelegramReply result:', result)
                }
              }
            }
          } catch (e) {
            console.error('Error processing Telegram message:', e)
          }
        }
      } catch (e) {
        console.error('Error polling Telegram:', e)
      } finally {
        _processing = false
      }
    }

    function startPolling() {
      if (_pollInterval !== null) return
      _pollInterval = setInterval(() => {
        void processTelegramMessages()
      }, 2000)
    }

    function stopPolling() {
      if (_pollInterval !== null) {
        clearInterval(_pollInterval)
        _pollInterval = null
      }
    }

    async function saveConfig(token: string, chatId: string) {
      const result = await window.electronAPI.homeAgent.saveConfig(token, chatId)
      if (result.success) {
        const configChanged =
          token !== telegramToken.value || chatId !== telegramChatId.value
        telegramToken.value = token
        telegramChatId.value = chatId
        // Reset verified only when credentials actually change — must re-verify
        if (configChanged) {
          telegramVerified.value = false
          isHomeAgentActive.value = false
        }
      }
      return result
    }

    async function clearConfig() {
      await window.electronAPI.homeAgent.clearConfig()
      telegramToken.value = null
      telegramChatId.value = null
      telegramVerified.value = false
      isHomeAgentActive.value = false
    }

    function setVerified() {
      telegramVerified.value = true
    }

    function activate() {
      if (!isAvailable.value) {
        toast.error(
          'Home Agent is not installed. Please install it from App Settings → Installation Management.',
        )
        return
      }
      if (!isReadyToActivate.value) {
        toast.error('Complete Telegram setup and verify the connection in Setup Wizard.')
        return
      }
      isHomeAgentActive.value = true
    }

    function deactivate() {
      isHomeAgentActive.value = false
    }

    function toggle() {
      if (isHomeAgentActive.value) {
        deactivate()
      } else {
        activate()
      }
    }

    return {
      isHomeAgentActive,
      isTelegramConfigured,
      isReadyToActivate,
      telegramVerified,
      telegramChatId,
      isAvailable,
      homeAgentBaseUrl,
      activate,
      deactivate,
      toggle,
      saveConfig,
      clearConfig,
      setVerified,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      // telegramChatId persisted (non-sensitive) for display purposes.
      // telegramVerified persisted — this is the key flag for "ready to activate".
      // telegramToken NOT persisted — lives only in safeStorage.
      pick: ['isHomeAgentActive', 'telegramVerified', 'telegramChatId'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useHomeAgent, import.meta.hot))
}
