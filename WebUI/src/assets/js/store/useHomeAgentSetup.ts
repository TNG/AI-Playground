import { ref, computed } from 'vue'
import { useHomeAgent } from './homeAgent'
import { useConversations } from './conversations'

const DETECT_POLL_INTERVAL_MS = 2000
const DETECT_TIMEOUT_MS = 5000

export function useHomeAgentSetup() {
  const homeAgent = useHomeAgent()
  const conversations = useConversations()

  const tokenInput = ref('')
  const showToken = ref(false)
  const detectedChatId = ref('')
  const detectStatus = ref<'idle' | 'loading' | 'error'>('idle')
  const detectError = ref('')
  const verifyStatus = ref<'idle' | 'loading' | 'success' | 'error'>('idle')
  const verifyError = ref('')

  // Whisper install state (local to setup session)
  const whisperInstallStatus = ref<'idle' | 'downloading' | 'ready' | 'error'>('idle')
  const whisperInstallError = ref('')
  const whisperEnabled = ref(false)
  let _whisperPollInterval: ReturnType<typeof setInterval> | null = null

  const isAlreadyConfigured = computed(() => homeAgent.isTelegramConfigured)

  // A valid token is <digits>:<35 alphanumeric chars>, total ≥ 40 chars with a colon
  const tokenFormatOk = computed(() => {
    const t = tokenInput.value.trim()
    return t.includes(':') && t.split(':')[0].length > 0 && t.length >= 40
  })

  const hasAnyToken = computed(() => !!tokenInput.value || isAlreadyConfigured.value)
  const hasAnyChatId = computed(() => !!detectedChatId.value || isAlreadyConfigured.value)

  const canVerify = computed(() => hasAnyToken.value && hasAnyChatId.value)
  const canSave = computed(
    () => hasAnyChatId.value && (isAlreadyConfigured.value || tokenFormatOk.value),
  )

  async function pollForChatId(token: string): Promise<{ chatId: string } | { error: string }> {
    // First try immediately (chat ID may already be in backend memory/file)
    try {
      const quick = await window.electronAPI.homeAgent.detectChatId(token)
      if ('chatId' in quick) return quick
    } catch (e) {
      console.error('pollForChatId initial detectChatId failed:', e)
      detectError.value = 'Failed to contact Home Agent backend. Is it running?'
      return { error: detectError.value }
    }

    // Not found yet — tell user to send a message and poll for up to DETECT_TIMEOUT_MS
    detectError.value = 'Waiting for a message… Open your bot in Telegram and send any message.'
    const deadline = Date.now() + DETECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DETECT_POLL_INTERVAL_MS))
      try {
        const r = await window.electronAPI.homeAgent.detectChatId(token)
        if ('chatId' in r) {
          detectError.value = ''
          return r
        }
      } catch (e) {
        console.error('pollForChatId poll detectChatId failed:', e)
        detectError.value = 'Failed to contact Home Agent backend. Is it running?'
        return { error: detectError.value }
      }
    }
    return {
      error:
        'Timed out waiting for a message. Make sure the bot is running and send any message to it, then click Detect again.',
    }
  }

  async function runDetectChatId() {
    detectStatus.value = 'loading'
    detectError.value = ''
    try {
      let result: { chatId: string } | { error: string }
      if (tokenInput.value) {
        // Inject token into running backend so it can start polling (if not already)
        try {
          await window.electronAPI.homeAgent.injectToken(tokenInput.value)
        } catch (e) {
          console.error('runDetectChatId: injectToken failed:', e)
          // Non-fatal — proceed to poll anyway; backend may already have it
        }
        // Poll /get-chat-id for up to DETECT_TIMEOUT_MS waiting for a message to arrive
        result = await pollForChatId(tokenInput.value)
      } else {
        result = await window.electronAPI.homeAgent.detectChatIdFromSaved()
      }
      if ('chatId' in result) {
        detectedChatId.value = result.chatId
        detectStatus.value = 'idle'
        // Discard the message(s) used for detection so they aren't replayed as prompts
        try {
          await window.electronAPI.homeAgent.flushPending()
        } catch (e) {
          console.error('runDetectChatId: flushPending failed:', e)
        }
      } else {
        detectStatus.value = 'error'
        detectError.value = result.error
      }
    } catch (e) {
      console.error('runDetectChatId failed:', e)
      detectStatus.value = 'error'
      detectError.value = e instanceof Error ? e.message : String(e)
    }
  }

  async function verify() {
    const token = tokenInput.value.trim()
    const chatId = detectedChatId.value || homeAgent.telegramChatId
    verifyStatus.value = 'loading'
    verifyError.value = ''
    try {
      // Save config first so testTelegram() can read it from the config file
      if (token && chatId) {
        const saveResult = await homeAgent.saveConfig(token, chatId)
        if (!saveResult.success) {
          verifyStatus.value = 'error'
          verifyError.value = saveResult.error ?? 'Failed to save config'
          return
        }
      }
      if (!chatId) {
        verifyStatus.value = 'error'
        verifyError.value = 'No chat ID — complete Step 2 (Detect) first.'
        return
      }
      const result = await window.electronAPI.homeAgent.testTelegram()
      if (result.success) {
        homeAgent.setVerified()
        verifyStatus.value = 'success'
      } else {
        verifyStatus.value = 'error'
        verifyError.value = result.error ?? 'Unknown error'
      }
    } catch (e) {
      console.error('verify: testTelegram failed:', e)
      verifyStatus.value = 'error'
      verifyError.value = e instanceof Error ? e.message : 'Verification failed'
    }
  }

  async function saveAndContinue() {
    const token = tokenInput.value.trim()
    const chatId = detectedChatId.value || homeAgent.telegramChatId || ''
    try {
      if (token && chatId) {
        // Preserve verified state across the save — if the user already verified
        // (either in this session or a previous one), keep it true.
        const wasVerified = homeAgent.telegramVerified
        await homeAgent.saveConfig(token, chatId)
        if (wasVerified) {
          homeAgent.setVerified()
        }
      }
    } catch (e) {
      console.error('saveAndContinue: failed to save Home Agent config:', e)
    } finally {
      // Clear the active conversation so the message sent during detection
      // isn't picked up as the first user prompt in Home Agent mode.
      conversations.addNewConversation()
    }
  }

  async function clearConfig() {
    try {
      await homeAgent.clearConfig()
    } catch (e) {
      console.error('clearConfig: failed to clear Home Agent config:', e)
    } finally {
      tokenInput.value = ''
      detectedChatId.value = ''
      detectStatus.value = 'idle'
      detectError.value = ''
      verifyStatus.value = 'idle'
      verifyError.value = ''
    }
  }

  async function installWhisper() {
    whisperInstallStatus.value = 'downloading'
    whisperInstallError.value = ''
    try {
      await window.electronAPI.homeAgent.downloadWhisperModel(homeAgent.whisperModelSize)
    } catch (e) {
      whisperInstallStatus.value = 'error'
      whisperInstallError.value = String(e)
      whisperEnabled.value = false
      return
    }
    // Poll until ready or error
    if (_whisperPollInterval) clearInterval(_whisperPollInterval)
    _whisperPollInterval = setInterval(async () => {
      try {
        const s = await window.electronAPI.homeAgent.getWhisperStatus()
        if (!s) return
        if (s.status === 'ready') {
          whisperInstallStatus.value = 'ready'
          if (_whisperPollInterval) clearInterval(_whisperPollInterval)
        } else if (s.status === 'error') {
          whisperInstallStatus.value = 'error'
          whisperInstallError.value = s.error
          whisperEnabled.value = false
          if (_whisperPollInterval) clearInterval(_whisperPollInterval)
        }
      } catch {
        // ignore transient errors
      }
    }, 2000)
  }

  async function toggleWhisper(value: boolean) {
    whisperEnabled.value = value
    if (value) {
      await installWhisper()
    } else {
      if (_whisperPollInterval) clearInterval(_whisperPollInterval)
      if (whisperInstallStatus.value !== 'idle') {
        whisperInstallStatus.value = 'idle'
        whisperInstallError.value = ''
      }
      try {
        await window.electronAPI.homeAgent.disableWhisper()
      } catch {
        // ignore
      }
    }
  }

  // On mount, check if whisper is already ready
  async function checkWhisperStatus() {
    try {
      const s = await window.electronAPI.homeAgent.getWhisperStatus()
      if (s?.status === 'ready') {
        whisperInstallStatus.value = 'ready'
        whisperEnabled.value = true
      }
    } catch {
      // ignore
    }
  }
  void checkWhisperStatus()

  return {
    homeAgent,
    tokenInput,
    showToken,
    detectedChatId,
    detectStatus,
    detectError,
    verifyStatus,
    verifyError,
    isAlreadyConfigured,
    tokenFormatOk,
    canVerify,
    canSave,
    whisperInstallStatus,
    whisperInstallError,
    whisperEnabled,
    runDetectChatId,
    verify,
    saveAndContinue,
    clearConfig,
    toggleWhisper,
  }
}
