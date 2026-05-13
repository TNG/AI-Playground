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

  const isAlreadyConfigured = computed(() => homeAgent.isTelegramConfigured)

  // A valid token is <digits>:<35 alphanumeric chars>, total ≥ 40 chars with a colon
  const tokenFormatOk = computed(() => {
    const t = tokenInput.value.trim()
    return t.includes(':') && t.split(':')[0].length > 0 && t.length >= 40
  })

  const hasAnyToken = computed(() => !!tokenInput.value || isAlreadyConfigured.value)
  const hasAnyChatId = computed(() => !!detectedChatId.value || isAlreadyConfigured.value)

  const canVerify = computed(() => hasAnyToken.value && hasAnyChatId.value)
  const canSave = computed(() => hasAnyToken.value && hasAnyChatId.value)

  async function pollForChatId(token: string): Promise<{ chatId: string } | { error: string }> {
    // First try immediately (chat ID may already be in backend memory/file)
    const quick = await window.electronAPI.homeAgent.detectChatId(token)
    if ('chatId' in quick) return quick

    // Not found yet — tell user to send a message and poll for up to DETECT_TIMEOUT_MS
    detectError.value = 'Waiting for a message… Open your bot in Telegram and send any message.'
    const deadline = Date.now() + DETECT_TIMEOUT_MS
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DETECT_POLL_INTERVAL_MS))
      const r = await window.electronAPI.homeAgent.detectChatId(token)
      if ('chatId' in r) {
        detectError.value = ''
        return r
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
    let result: { chatId: string } | { error: string }
    if (tokenInput.value) {
      // Inject token into running backend so it can start polling (if not already)
      await window.electronAPI.homeAgent.injectToken(tokenInput.value)
      // Poll /get-chat-id for up to DETECT_TIMEOUT_MS waiting for a message to arrive
      result = await pollForChatId(tokenInput.value)
    } else {
      result = await window.electronAPI.homeAgent.detectChatIdFromSaved()
    }
    if ('chatId' in result) {
      detectedChatId.value = result.chatId
      detectStatus.value = 'idle'
      // Discard the message(s) used for detection so they aren't replayed as prompts
      await window.electronAPI.homeAgent.flushPending()
    } else {
      detectStatus.value = 'error'
      detectError.value = result.error
    }
  }

  async function verify() {
    const token = tokenInput.value
    const chatId = detectedChatId.value || homeAgent.telegramChatId!
    if (token && chatId) {
      await homeAgent.saveConfig(token, chatId)
    }
    verifyStatus.value = 'loading'
    verifyError.value = ''
    const result = await window.electronAPI.homeAgent.testTelegram()
    if (result.success) {
      verifyStatus.value = 'success'
      homeAgent.setVerified()
    } else {
      verifyStatus.value = 'error'
      verifyError.value = result.error ?? 'Unknown error'
    }
  }

  async function saveAndContinue() {
    const token = tokenInput.value
    const chatId = detectedChatId.value || homeAgent.telegramChatId || ''
    if (token && chatId) {
      // Preserve verified state across the save — if the user already verified
      // (either in this session or a previous one), keep it true.
      const wasVerified = homeAgent.telegramVerified
      await homeAgent.saveConfig(token, chatId)
      if (wasVerified) {
        homeAgent.setVerified()
      }
    }
    // Clear the active conversation so the message sent during detection
    // isn't picked up as the first user prompt in Home Agent mode.
    conversations.addNewConversation()
  }

  async function clearConfig() {
    await homeAgent.clearConfig()
    tokenInput.value = ''
    detectedChatId.value = ''
    detectStatus.value = 'idle'
    verifyStatus.value = 'idle'
  }

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
    runDetectChatId,
    verify,
    saveAndContinue,
    clearConfig,
  }
}
