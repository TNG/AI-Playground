import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useOpenAiCompatibleChat, type AipgUiMessage } from './openAiCompatibleChat'
import { useImageGenerationPresets, isImage } from './imageGenerationPresets'
import { usePromptStore } from './promptArea'
import { usePresetSwitching } from './presetSwitching'
import { HOME_AGENT_HELP_BODY } from '../homeAgentHelpMessage'
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
    const imageGenStore = useImageGenerationPresets()
    const promptStore = usePromptStore()
    const presetSwitching = usePresetSwitching()

    const isHomeAgentActive = ref(false)
    const telegramToken = ref<string | null>(null)
    const telegramChatId = ref<string | null>(null)
    const telegramVerified = ref(false)

    let _pollInterval: ReturnType<typeof setInterval> | null = null
    const _messageQueue: string[] = []
    let _draining = false
    let _userDisabled = false

    const isTelegramConfigured = computed(() => !!telegramToken.value && !!telegramChatId.value)

    // "Ready to activate" = previously verified. telegramVerified is persisted,
    // so this is true immediately on startup if the user verified in a previous run.
    const isReadyToActivate = computed(() => telegramVerified.value)

    const isAvailable = computed(
      () =>
        backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.status ===
        'running',
    )

    const homeAgentBaseUrl = computed(
      () => backendServices.info.find((s) => s.serviceName === 'home-agent-backend')?.baseUrl,
    )

    // When the backend becomes available and Telegram has been verified, auto-activate.
    watch(isAvailable, (val) => {
      if (val && isReadyToActivate.value && !_userDisabled) {
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
      } else if (isAvailable.value && !_userDisabled) {
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

    const IMG_GEN_REGEX = /^\/imgGen\s*/i
    const HELP_REGEX = /^\/help$/i
    const IMG_GEN_TIMEOUT_MS = 120_000

    const HELP_MESSAGE = HOME_AGENT_HELP_BODY

    async function handleChatMessage(text: string): Promise<void> {
      promptStore.setModeOnly('chat')
      await chatStore.generate(text)
      if (!isHomeAgentActive.value) return
      const reply = extractAssistantReply(chatStore.messages ?? undefined)
      if (reply) {
        await window.electronAPI.homeAgent.sendTelegramReply(reply)
      }
    }

    async function imageToBase64(imageUrl: string): Promise<string> {
      const resp = await fetch(imageUrl)
      const arrayBuf = await resp.arrayBuffer()
      const bytes = new Uint8Array(arrayBuf)
      let binary = ''
      const CHUNK = 8192
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
      }
      return btoa(binary)
    }

    async function sendImageToTelegram(imageUrl: string, caption: string): Promise<void> {
      try {
        const base64 = await imageToBase64(imageUrl)
        await window.electronAPI.homeAgent.sendTelegramPhoto(base64, caption)
      } catch (e) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          `⚠️ Image was generated but could not be sent: ${e instanceof Error ? e.message : String(e)}`,
        )
      }
    }

    /**
     * After generate() is called, wait for all newly enqueued images to finish
     * (done or stopped/error) sending each one to Telegram as soon as it's ready.
     * Returns when all images have been handled or the timeout expires.
     */
    async function waitAndSendAllImages(newImageIds: Set<string>, prompt: string): Promise<void> {
      const deadline = Date.now() + IMG_GEN_TIMEOUT_MS
      const sentIds = new Set<string>()

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500))

        for (const id of newImageIds) {
          if (sentIds.has(id)) continue
          const img = imageGenStore.generatedImages.find((i) => i.id === id)
          if (!img) continue

          if (img.state === 'done' && isImage(img) && img.imageUrl) {
            sentIds.add(id)
            await sendImageToTelegram(img.imageUrl, prompt)
          } else if (img.state === 'stopped') {
            sentIds.add(id) // count as handled, don't send
          }
        }

        // Check for global error state
        if (imageGenStore.currentState === 'error') {
          const remaining = [...newImageIds].filter((id) => !sentIds.has(id))
          if (remaining.length > 0) {
            await window.electronAPI.homeAgent.sendTelegramReply(
              '⚠️ Image generation failed. Please check AI Playground for details.',
            )
          }
          return
        }

        // All images handled
        if (sentIds.size === newImageIds.size) return
      }

      // Timeout — report images that never completed
      const unsent = [...newImageIds].filter((id) => !sentIds.has(id))
      if (unsent.length > 0) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          `⚠️ ${unsent.length} image(s) timed out and were not sent.`,
        )
      }
    }

    async function handleImgGenMessage(prompt: string): Promise<void> {
      // Check ComfyUI backend
      const comfyService = backendServices.info.find((s) => s.serviceName === 'comfyui-backend')
      if (!comfyService || comfyService.status !== 'running') {
        await window.electronAPI.homeAgent.sendTelegramReply(
          '⚠️ Image generation is not available — the ComfyUI backend is not running.',
        )
        return
      }

      // Ensure imageGen mode is active and preset is loaded before checking activePreset
      promptStore.setModeOnly('imageGen')
      await presetSwitching.switchToLastUsedForCategory(['create-images'], 'comfy', {
        skipModeSwitch: true,
      })

      // Check active preset
      if (!imageGenStore.activePreset) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          '⚠️ No image generation preset is selected. Please configure one in AI Playground.',
        )
        return
      }

      // Validate requirements without showing dialogs
      const validation = await imageGenStore.validatePresetRequirements()
      if (!validation.backendRunning) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          '⚠️ Image generation is not available — the ComfyUI backend is not running.',
        )
        return
      }
      if (
        validation.missingCustomNodes.length > 0 ||
        validation.missingPythonPackages.length > 0 ||
        validation.missingModels.length > 0
      ) {
        const parts: string[] = []
        if (validation.missingModels.length > 0)
          parts.push(`missing models: ${validation.missingModels.map((m) => m.repo_id).join(', ')}`)
        if (validation.missingCustomNodes.length > 0)
          parts.push(`missing custom nodes: ${validation.missingCustomNodes.join(', ')}`)
        if (validation.missingPythonPackages.length > 0)
          parts.push(`missing packages: ${validation.missingPythonPackages.join(', ')}`)
        await window.electronAPI.homeAgent.sendTelegramReply(
          `⚠️ Image generation requirements are not met: ${parts.join('; ')}. Please configure AI Playground first.`,
        )
        return
      }

      const knownIdsBefore = new Set(imageGenStore.generatedImages.map((img) => img.id))
      imageGenStore.prompt = prompt
      try {
        await imageGenStore.generate('imageGen')
      } catch (e) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          `⚠️ Image generation failed to start: ${e instanceof Error ? e.message : String(e)}`,
        )
        return
      }

      // Collect IDs of all newly enqueued images (added by generate())
      const newImageIds = new Set(
        imageGenStore.generatedImages
          .filter((img) => !knownIdsBefore.has(img.id))
          .map((img) => img.id),
      )

      if (newImageIds.size === 0) {
        await window.electronAPI.homeAgent.sendTelegramReply(
          '⚠️ Image generation did not produce any images.',
        )
        return
      }

      // Wait for all images and send each one as it finishes; UI stays in imageGen mode
      await waitAndSendAllImages(newImageIds, prompt)
    }

    async function drainQueue() {
      if (_draining) return
      _draining = true
      try {
        while (_messageQueue.length > 0 && isHomeAgentActive.value) {
          const text = _messageQueue.shift()!
          try {
            if (HELP_REGEX.test(text)) {
              await window.electronAPI.homeAgent.sendTelegramReply(HELP_MESSAGE, 'HTML')
            } else if (IMG_GEN_REGEX.test(text)) {
              const prompt = text.replace(IMG_GEN_REGEX, '').trim()
              if (prompt) {
                await handleImgGenMessage(prompt)
              } else {
                await window.electronAPI.homeAgent.sendTelegramReply(
                  '⚠️ Please add a prompt after the command.\nExample: <code>/imgGen a cat on the moon</code>',
                  'HTML',
                )
              }
            } else {
              await handleChatMessage(text)
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
      _messageQueue.length = 0
    }

    async function saveConfig(
      token: string,
      chatId: string,
    ): Promise<{ success: boolean; error?: string }> {
      try {
        const result = await window.electronAPI.homeAgent.saveConfig(token, chatId)
        if (result.success) {
          const configChanged = token !== telegramToken.value || chatId !== telegramChatId.value
          telegramToken.value = token
          telegramChatId.value = chatId
          // Reset verified only when credentials actually change — must re-verify
          if (configChanged) {
            telegramVerified.value = false
            isHomeAgentActive.value = false
            _userDisabled = false
          }
        }
        return result
      } catch (e) {
        console.error('homeAgent.saveConfig failed:', e)
        return { success: false, error: String(e) }
      }
    }

    async function clearConfig(): Promise<void> {
      try {
        await window.electronAPI.homeAgent.clearConfig()
      } catch (e) {
        console.error('homeAgent.clearConfig failed:', e)
      }
      telegramToken.value = null
      telegramChatId.value = null
      telegramVerified.value = false
      isHomeAgentActive.value = false
      _userDisabled = false
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
      _userDisabled = false
      isHomeAgentActive.value = true
    }

    function toggle() {
      if (isHomeAgentActive.value) {
        _userDisabled = true
        isHomeAgentActive.value = false
      } else {
        activate()
      }
    }

    // Load token from safeStorage (not persisted to disk for security).
    // telegramChatId and telegramVerified ARE persisted, so they are already
    // populated synchronously before this resolves.
    async function initConfig() {
      try {
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
      } catch (e) {
        console.error('homeAgent.initConfig failed:', e)
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
