import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useOpenAiCompatibleChat, type AipgUiMessage } from './openAiCompatibleChat'
import * as toast from '../toast'

const POLL_INTERVAL_MS = 2000
const MAX_QUEUE_SIZE = 20

function extractAssistantReply(messages: AipgUiMessage[] | undefined): string | null {
  if (!messages || messages.length === 0) return null
  const last = messages[messages.length - 1]
  if (last.role !== 'assistant') return null
  const text = (last.parts as { type: string; text?: string }[])
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('')
  return text || null
}

export const useHomeAgent = defineStore(
  'homeAgent',
  () => {
    const backendServices = useBackendServices()
    const chatStore = useOpenAiCompatibleChat()

    const isHomeAgentActive = ref(false)
    const telegramToken = ref<string | null>(null)
    const telegramChatId = ref<string | null>(null)
    const telegramVerified = ref(false)

    let _pollInterval: ReturnType<typeof setInterval> | null = null
    const _messageQueue: string[] = []
    let _draining = false

    const isTelegramConfigured = computed(() => !!telegramToken.value && !!telegramChatId.value)

    // "Ready to activate" = previously verified. telegramVerified is persisted,
    // so this is true immediately on startup if the user verified in a previous run.
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

    async function drainQueue() {
      if (_draining) return
      _draining = true
      try {
        while (_messageQueue.length > 0) {
          const text = _messageQueue.shift()!
          try {
            await chatStore.generate(text)
            const reply = extractAssistantReply(chatStore.messages ?? undefined)
            if (reply) {
              await window.electronAPI.homeAgent.sendTelegramReply(reply)
            }
          } catch (e) {
            console.error('Error processing Telegram message:', e)
          }
        }
      } finally {
        _draining = false
      }
    }

    async function processTelegramMessages() {
      try {
        const msgs = await window.electronAPI.homeAgent.pollTelegram()
        if (!msgs || msgs.length === 0) return
        for (const msg of msgs) {
          if (_messageQueue.length >= MAX_QUEUE_SIZE) {
            toast.warning('Home Agent: message queue full, dropping oldest message.')
            _messageQueue.shift()
          }
          _messageQueue.push(msg.text)
        }
        void drainQueue()
      } catch (e) {
        console.error('Error polling Telegram:', e)
      }
    }

    function startPolling() {
      if (_pollInterval !== null) return
      _pollInterval = setInterval(() => {
        void processTelegramMessages()
      }, POLL_INTERVAL_MS)
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
        const configChanged = token !== telegramToken.value || chatId !== telegramChatId.value
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

    function toggle() {
      if (isHomeAgentActive.value) {
        isHomeAgentActive.value = false
      } else {
        activate()
      }
    }

    // Load token from safeStorage (not persisted to disk for security).
    // telegramChatId and telegramVerified ARE persisted, so they are already
    // populated synchronously before this resolves.
    async function initConfig() {
      const cfg = await window.electronAPI.homeAgent.loadConfig()
      if (cfg) {
        telegramToken.value = cfg.token
        telegramChatId.value = cfg.chatId
      } else if (!telegramVerified.value) {
        // No config in safeStorage — clear everything only if nothing was persisted
        telegramToken.value = null
        telegramChatId.value = null
        isHomeAgentActive.value = false
      }
    }

    void initConfig()

    return {
      isHomeAgentActive,
      isTelegramConfigured,
      isReadyToActivate,
      telegramVerified,
      telegramChatId,
      isAvailable,
      homeAgentBaseUrl,
      activate,
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
      // isHomeAgentActive NOT persisted — re-derived on startup by watchers
      //   (isAvailable is false until the backend service reports ready).
      pick: ['telegramVerified', 'telegramChatId'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useHomeAgent, import.meta.hot))
}
