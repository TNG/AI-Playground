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

export const useQwen3TextToSpeech = defineStore(
  'qwen3TextToSpeech',
  () => {
    const backendServices = useBackendServices()

    /** Default voice when the agent omits `speaker`. User can change in settings or chat. */
    const defaultSpeaker = ref<Qwen3TtsSpeakerId>('Ryan')
    const defaultLanguage = ref<Qwen3TtsLanguage>('Auto')
    /** `voice_design` uses natural-language voice descriptions via `instruct`. */
    const defaultMode = ref<Qwen3TtsSynthesisMode>('custom_voice')
    /** Free-form voice description used when `mode === 'voice_design'` and no per-call
     *  `instruct` is supplied (e.g. the direct-synthesis TTS preset). */
    const defaultInstruct = ref<string>('')

    async function ensureBackendRunning(): Promise<string> {
      const info = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      if (!info?.isSetUp) {
        throw new Error(
          'Text To Speech is not installed. Install it from Settings → Installation Management, then try again.',
        )
      }
      if (info.status !== 'running') {
        await backendServices.startService('qwen3-tts-backend')
      }
      const running = backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')
      const baseUrl = running?.baseUrl
      if (!baseUrl) {
        throw new Error('Text To Speech backend URL is not available')
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
      const mode = args.mode ?? defaultMode.value
      const body = {
        text: args.text,
        language: args.language ?? defaultLanguage.value,
        speaker: args.speaker ?? defaultSpeaker.value,
        // For voice_design fall back to the saved description when the caller omits one.
        instruct: args.instruct ?? (mode === 'voice_design' ? defaultInstruct.value : undefined),
        mode,
      }
      const response = await qwen3TtsFetch(`${baseUrl}/api/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const payload = (await response.json()) as Qwen3TtsApiResponse<Qwen3TtsSynthesizeResult>
      if (!response.ok || payload.code !== 0 || !payload.data) {
        throw new Error(payload.message ?? `Text To Speech synthesis failed (${response.status})`)
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
      toast.success('Updated default Text To Speech voice settings for this session')
    }

    /** Mirrors `isQwen3TtsEnabled` from settings.json (dev: settings-dev.json). */
    const isFeatureEnabled = ref(false)

    async function initFeatureFlag() {
      try {
        const localSettings = await window.electronAPI.getLocalSettings()
        isFeatureEnabled.value = !!localSettings.isQwen3TtsEnabled
      } catch (e) {
        console.error('qwen3TextToSpeech.initFeatureFlag failed:', e)
        isFeatureEnabled.value = false
      }
    }
    void initFeatureFlag()

    return {
      defaultSpeaker,
      defaultLanguage,
      defaultMode,
      defaultInstruct,
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
      pick: ['defaultSpeaker', 'defaultLanguage', 'defaultMode', 'defaultInstruct'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useQwen3TextToSpeech, import.meta.hot))
}
