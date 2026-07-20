import { defineStore } from 'pinia'
import { ref } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import * as toast from '@/assets/js/toast'
import { qwen3TtsFetch } from '@/lib/loopbackAuth'
import type {
  Qwen3TtsApiResponse,
  Qwen3TtsLanguage,
  Qwen3TtsSpeakerId,
  Qwen3TtsSynthesisMode,
  Qwen3TtsSynthesizeResult,
} from '@/assets/js/qwen3TtsConstants'

export const useQwen3Tts = defineStore(
  'qwen3Tts',
  () => {
    const backendServices = useBackendServices()

    /** Default voice when the agent omits `speaker`. User can change in settings or chat. */
    const defaultSpeaker = ref<Qwen3TtsSpeakerId>('Ryan')
    const defaultLanguage = ref<Qwen3TtsLanguage>('Auto')
    /** `voice_design` uses natural-language voice descriptions via `instruct`. */
    const defaultMode = ref<Qwen3TtsSynthesisMode>('custom_voice')

    async function ensureBackendRunning(): Promise<string> {
      const info = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      if (!info?.isSetUp) {
        throw new Error(
          'Qwen3 TTS is not installed. Install it from Settings → Installation Management, then try again.',
        )
      }
      if (info.status !== 'running') {
        await backendServices.startService('qwen3-tts-backend')
      }
      const running = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      const baseUrl = running?.baseUrl
      if (!baseUrl) {
        throw new Error('Qwen3 TTS backend URL is not available')
      }
      return baseUrl.replace(/\/$/, '')
    }

    async function synthesize(args: {
      text: string
      language?: Qwen3TtsLanguage
      speaker?: Qwen3TtsSpeakerId
      instruct?: string
      mode?: Qwen3TtsSynthesisMode
    }): Promise<Qwen3TtsSynthesizeResult> {
      const baseUrl = await ensureBackendRunning()
      const body = {
        text: args.text,
        language: args.language ?? defaultLanguage.value,
        speaker: args.speaker ?? defaultSpeaker.value,
        instruct: args.instruct,
        mode: args.mode ?? defaultMode.value,
      }
      const response = await qwen3TtsFetch(`${baseUrl}/api/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await response.json()) as Qwen3TtsApiResponse<Qwen3TtsSynthesizeResult>
      if (!response.ok || payload.code !== 0 || !payload.data) {
        throw new Error(payload.message ?? `Qwen3 TTS synthesis failed (${response.status})`)
      }
      return payload.data
    }

    /** Persist WAV bytes under Documents/AI-Playground/audio and return the absolute path. */
    async function saveWavToDisk(audioBase64: string, suggestedName: string): Promise<string> {
      const result = await window.electronAPI.saveGeneratedAudio(audioBase64, suggestedName)
      if (!result.success || !result.filePath) {
        throw new Error(result.error ?? 'Failed to save audio file')
      }
      return result.filePath
    }

    function isBackendSetUp(): boolean {
      return (
        backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')?.isSetUp === true
      )
    }

    async function applyUserVoicePreference(args: {
      speaker?: Qwen3TtsSpeakerId
      language?: Qwen3TtsLanguage
      mode?: Qwen3TtsSynthesisMode
    }): Promise<void> {
      if (args.speaker) defaultSpeaker.value = args.speaker
      if (args.language) defaultLanguage.value = args.language
      if (args.mode) defaultMode.value = args.mode
      toast.success('Updated default Qwen3 TTS voice settings for this session')
    }

    /** Mirrors `isQwen3TtsEnabled` from settings.json (dev: settings-dev.json). */
    const isFeatureEnabled = ref(false)

    async function initFeatureFlag() {
      try {
        const localSettings = await window.electronAPI.getLocalSettings()
        isFeatureEnabled.value = !!localSettings.isQwen3TtsEnabled
      } catch (e) {
        console.error('qwen3Tts.initFeatureFlag failed:', e)
        isFeatureEnabled.value = false
      }
    }
    void initFeatureFlag()

    return {
      defaultSpeaker,
      defaultLanguage,
      defaultMode,
      isFeatureEnabled,
      synthesize,
      saveWavToDisk,
      ensureBackendRunning,
      isBackendSetUp,
      applyUserVoicePreference,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['defaultSpeaker', 'defaultLanguage', 'defaultMode'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useQwen3Tts, import.meta.hot))
}
