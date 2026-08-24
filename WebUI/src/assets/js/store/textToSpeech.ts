import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import { useDialogStore } from './dialogs'
import * as toast from '@/assets/js/toast'
import { useSetupWizard } from './setupWizard'
import { useProductMode } from './productMode'
import { synthesizeSpeech, bytesToBlobUrl, bytesToBase64 } from '@/lib/synthesizeSpeech'
import { markdownToSpeechText } from '@/lib/markdownToSpeech'

export const SPEECHT5_MODEL_NAME = 'tngtech/Kokoro-82M-int8-ov'

/** Which engine backs Text To Speech.
 *  - `qwen3`: Qwen3-TTS on its own backend — works in every product mode.
 *  - `kokoro`: OpenVINO OVMS speech server — offered only when OpenVINO is
 *    installable (non-NVIDIA mode) and set up.
 *  - `external`: an OpenAI-compatible fallback endpoint configured in App Settings —
 *    offered only when that fallback is enabled (works in every mode, incl. NVIDIA). */
export type TtsEngine = 'qwen3' | 'kokoro' | 'external'

/** Kokoro-82M voices exposed in the TTS preset when the Kokoro engine is selected.
 *  These map 1:1 to the voice ids the OVMS `text2speech` (kokoro) task accepts. */
export const KOKORO_VOICES = [
  'af_heart',
  'af_bella',
  'af_nicole',
  'af_sarah',
  'af_sky',
  'am_adam',
  'am_michael',
  'bf_emma',
  'bf_isabella',
  'bm_george',
  'bm_lewis',
] as const
export type KokoroVoice = (typeof KOKORO_VOICES)[number]

/**
 * Resolved text-to-speech endpoint configuration consumed by the shared
 * `synthesizeSpeech` helper. `baseURL` is an OpenAI-compatible base (ending in
 * `/v3` for OVMS or `/v1` for a generic server); `model` is the model id to
 * request; `voice` may be empty when the server has a single default voice;
 * `apiKey` may be empty for local servers.
 */
export type SpeechEndpoint = {
  baseURL: string
  model: string
  voice: string
  apiKey: string
}

/**
 * Configurable fallback text-to-speech endpoint. Used when the OVMS
 * text2speech server is not available (e.g. on macOS, where OVMS does not
 * run). Points at any OpenAI-compatible `/v1/audio/speech` server.
 */
export type TtsFallbackConfig = {
  enabled: boolean
  baseUrl: string
  model: string
  voice: string
  apiKey: string
}

export const useTextToSpeech = defineStore(
  'textToSpeech',
  () => {
    const enabled = ref(false)
    const initializing = ref(false)
    // Note: "Speak replies" is a per-preset tool setting (textInference.speakReplies,
    // edited on the Text To Speech tool row), not TTS-engine config — see
    // `textInference.speakRepliesAllowed`.

    // Which engine the TTS preset (and the synthesizeTextToSpeech tool) uses. Edited
    // in SettingsTts; 'kokoro' is only selectable when `isKokoroAvailable` is true.
    const selectedEngine = ref<TtsEngine>('qwen3')
    // The Kokoro voice used for the OVMS text2speech path.
    const selectedKokoroVoice = ref<KokoroVoice>('af_heart')
    const backendServices = useBackendServices()
    const models = useModels()
    const dialogStore = useDialogStore()
    const setupWizard = useSetupWizard()
    const productMode = useProductMode()

    /**
     * App-wide fallback speech endpoint. Shared by the desktop auto-play path
     * and the Home Agent voice-reply pipeline so TTS works even without OVMS.
     */
    const fallback = ref<TtsFallbackConfig>({
      enabled: false,
      baseUrl: '',
      model: 'tts-1',
      voice: '',
      apiKey: '',
    })

    // Playback state for the desktop UI.
    const isSpeaking = ref(false)
    const speakingMessageId = ref<string | null>(null)
    // Transient flag: set when a mic transcript arrives, consumed on reply
    // completion so we only auto-speak turns that originated from speech.
    const pendingVoiceTurn = ref(false)

    let currentAudio: HTMLAudioElement | null = null
    let currentObjectUrl: string | null = null

    /** True when a usable fallback endpoint is configured. */
    function hasFallback(): boolean {
      return fallback.value.enabled && fallback.value.baseUrl.trim().length > 0
    }

    /**
     * Whether the Kokoro (OpenVINO) engine can be offered as a TTS choice: OpenVINO
     * must be installable in this product mode (not NVIDIA) and set up. The external
     * fallback is a separate engine now (see {@link isExternalAvailable}).
     */
    const isKokoroAvailable = computed(() => {
      if (productMode.isNvidiaModeSelected) return false
      const ov = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
      return ov?.isSetUp === true
    })

    /** Whether the external (fallback) endpoint engine is configured/usable. */
    const isExternalAvailable = computed(() => hasFallback())

    /**
     * Whether "speak replies aloud" is usable at all: either Kokoro (OVMS) or a
     * configured external endpoint. Used by the desktop Speak button / auto-speak and
     * the Home Agent voice reply now that the old global TTS enable toggle is gone.
     *
     * Deliberately excludes the Qwen3 engine: those consumers all go through
     * `speak()` → `resolveSpeech()`, which only knows the OVMS and external
     * endpoints. Qwen3 synthesis lives in the qwen3TextToSpeech store, so it must
     * not be counted here — check the Qwen backend separately if you need it.
     */
    const available = computed(() => isKokoroAvailable.value || isExternalAvailable.value)

    /**
     * Resolve which speech endpoint to use. A configured fallback wins: it is an
     * explicit choice, and it is the only endpoint that works where OVMS is
     * installed but cannot run (macOS, where its binary is not executable).
     * Otherwise the OVMS text2speech server serves synthesis. Returns `null`
     * when neither is available.
     */
    async function resolveSpeech(): Promise<SpeechEndpoint | null> {
      if (hasFallback()) {
        return {
          baseURL: fallback.value.baseUrl.trim(),
          model: fallback.value.model.trim() || 'tts-1',
          voice: fallback.value.voice.trim() || 'af_heart',
          apiKey: fallback.value.apiKey,
        }
      }

      try {
        const ovmsUrl = await backendServices.getSpeechServerUrl()
        if (ovmsUrl) {
          return {
            baseURL: ovmsUrl,
            model: SPEECHT5_MODEL_NAME.split('/').join('---'),
            voice: selectedKokoroVoice.value,
            apiKey: '',
          }
        }
      } catch (error) {
        console.error('Failed to resolve OVMS speech server URL:', error)
      }

      return null
    }

    /**
     * Ensures the speech server is running when TTS is enabled.
     * Does NOT auto-disable TTS on failure.
     */
    async function ensureSpeechServerRunning(): Promise<void> {
      if (!enabled.value) return

      // A configured fallback serves synthesis, so there is no OVMS server to
      // start — and trying anyway is what used to break TTS on hosts where OVMS
      // is installed but cannot execute.
      if (hasFallback()) return

      const openVinoService = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
      if (!openVinoService?.isSetUp) return

      const modelExists = await models.checkSpeechModelExists(SPEECHT5_MODEL_NAME)
      if (!modelExists) return

      try {
        const url = await backendServices.getSpeechServerUrl()
        if (!url) {
          await backendServices.startSpeechServer(SPEECHT5_MODEL_NAME)
        }
      } catch (error) {
        console.error('Failed to ensure speech server is running:', error)
      }
    }

    /**
     * Ensure the Kokoro (OVMS) speech server is ready to synthesize: OpenVINO must
     * be set up (or a fallback is configured), the model must be present (prompting
     * the standard download popup if missing), and the server must be running. Used
     * by the direct TTS-preset path and the agentic tool when the Kokoro engine is
     * selected — independent of the `enabled` toggle.
     */
    async function ensureKokoroReady(): Promise<void> {
      const openVinoService = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
      if (!openVinoService?.isSetUp) {
        throw new Error(
          'OpenVINO backend is required for the Kokoro engine. Install it from ' +
            'Settings → Installation Management, or select the External endpoint engine.',
        )
      }

      const modelExists = await models.checkSpeechModelExists(SPEECHT5_MODEL_NAME)
      if (!modelExists) {
        const missing = await models.getMissingSpeechModel(SPEECHT5_MODEL_NAME)
        if (missing.length > 0) {
          await new Promise<void>((resolve, reject) => {
            dialogStore.showDownloadDialog(
              missing,
              () => resolve(),
              () => reject(new Error('Kokoro speech model download was cancelled')),
            )
          })
        }
      }

      const url = await backendServices.getSpeechServerUrl()
      if (!url) {
        await backendServices.startSpeechServer(SPEECHT5_MODEL_NAME)
      }
    }

    /**
     * Synthesize `text` with the currently-selected non-Qwen engine (Kokoro or the
     * external endpoint) and return the WAV audio as base64, so callers can save it
     * to disk and render an audio bubble (mirroring the Qwen3-TTS direct path).
     *
     * Also returns the voice actually used: the external engine may have its own
     * configured voice, so callers must not assume `selectedKokoroVoice` when
     * reporting what was spoken.
     */
    async function synthesizeToWav(text: string): Promise<{ audioBase64: string; voice: string }> {
      let endpoint: SpeechEndpoint | null
      if (selectedEngine.value === 'qwen3') {
        // Qwen3 synthesizes through its own backend store (useQwen3TextToSpeech),
        // not through a speech endpoint — callers branch on the engine before
        // getting here. Fail loudly rather than silently synthesizing on OVMS.
        throw new Error(
          'synthesizeToWav does not support the Qwen3 engine — use the qwen3TextToSpeech store.',
        )
      }
      if (selectedEngine.value === 'external') {
        // Force the configured external endpoint (don't prefer a running OVMS).
        if (!hasFallback()) {
          throw new Error('No external speech endpoint is configured (enable it in App Settings).')
        }
        endpoint = {
          baseURL: fallback.value.baseUrl.trim(),
          model: fallback.value.model.trim() || 'tts-1',
          voice: fallback.value.voice.trim() || selectedKokoroVoice.value,
          apiKey: fallback.value.apiKey,
        }
      } else {
        // Kokoro: start the OVMS speech server, then use it.
        await ensureKokoroReady()
        endpoint = await resolveSpeech()
        if (!endpoint) {
          throw new Error('Kokoro Text To Speech is not available (no OVMS server).')
        }
      }
      const { bytes } = await synthesizeSpeech(text, endpoint)
      return { audioBase64: bytesToBase64(bytes), voice: endpoint.voice }
    }

    /**
     * Initialize the speech server on app startup if TTS is enabled.
     * Validates prerequisites and auto-disables TTS if they are not met.
     */
    async function initialize(): Promise<void> {
      if (productMode.isNvidiaModeSelected) {
        enabled.value = false
        return
      }

      if (!enabled.value) return

      initializing.value = true

      try {
        // A configured fallback needs no local prerequisites: stay enabled and
        // leave OVMS alone.
        if (hasFallback()) return

        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService?.isSetUp) {
          enabled.value = false
          toast.warning('Text To Speech disabled: OpenVINO backend is not installed')
          return
        }

        const modelExists = await models.checkSpeechModelExists(SPEECHT5_MODEL_NAME)
        if (!modelExists) {
          enabled.value = false
          toast.warning('Text To Speech disabled: speech model not found')
          return
        }

        const url = await backendServices.getSpeechServerUrl()
        if (!url) {
          await backendServices.startSpeechServer(SPEECHT5_MODEL_NAME)
        }
      } catch (error) {
        enabled.value = false
        const errorMessage = error instanceof Error ? error.message : String(error)
        toast.error(`Text To Speech disabled: ${errorMessage}`)
      } finally {
        initializing.value = false
      }
    }

    /**
     * Toggle Text To Speech functionality.
     * Handles validation, installation checks, model downloads, and server management.
     */
    async function toggle(isEnabled: boolean): Promise<void> {
      if (isEnabled && productMode.isNvidiaModeSelected) {
        return
      }

      if (isEnabled) {
        // A configured fallback endpoint is the speech source, whatever state
        // OVMS is in: nothing to install, download or start.
        if (hasFallback()) {
          enabled.value = true
          toast.success('Text To Speech enabled (using fallback speech endpoint)')
          return
        }

        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService || !openVinoService.isSetUp) {
          dialogStore.showWarningDialog(
            'OpenVINO backend is required for Text To Speech. Please install it first, or configure a fallback speech endpoint in Settings.',
            () => {
              setupWizard.openWizard()
            },
          )
          return
        }

        const modelExists = await models.checkSpeechModelExists(SPEECHT5_MODEL_NAME)

        if (!modelExists) {
          const missingModels = await models.getMissingSpeechModel(SPEECHT5_MODEL_NAME)
          if (missingModels.length > 0) {
            dialogStore.showDownloadDialog(
              missingModels,
              async () => {
                try {
                  await backendServices.startSpeechServer(SPEECHT5_MODEL_NAME)
                  enabled.value = true
                  toast.success('Text To Speech enabled')
                } catch (error) {
                  toast.error(`Failed to start speech server: ${error}`)
                }
              },
              () => {
                toast.warning('Text To Speech requires the speech model')
              },
            )
            return
          }
        }

        try {
          await backendServices.startSpeechServer(SPEECHT5_MODEL_NAME)
          enabled.value = true
          toast.success('Text To Speech enabled')
        } catch (error) {
          toast.error(`Failed to start speech server: ${error}`)
        }
      } else if (hasFallback()) {
        // Nothing was started locally, so turning TTS off is just a flag.
        enabled.value = false
        toast.success('Text To Speech disabled')
      } else {
        try {
          await backendServices.stopSpeechServer()
          enabled.value = false
          toast.success('Text To Speech disabled')
        } catch (error) {
          toast.error(`Failed to stop speech server: ${error}`)
        }
      }
    }

    /** Stop any in-progress playback and release the object URL. */
    function stopSpeaking(): void {
      if (currentAudio) {
        currentAudio.pause()
        currentAudio.src = ''
        currentAudio = null
      }
      if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl)
        currentObjectUrl = null
      }
      isSpeaking.value = false
      speakingMessageId.value = null
    }

    /**
     * Synthesize `text` and play it back in the desktop app. `id` ties the
     * playback to a specific chat message so the UI can show a stop affordance.
     */
    async function speak(text: string, id?: string): Promise<void> {
      const trimmed = markdownToSpeechText(text ?? '').trim()
      if (!trimmed) return

      stopSpeaking()

      // Start the OVMS speech server on demand (no-op if already running or if the
      // model isn't installed — in which case a configured fallback still serves).
      await ensureSpeechServerRunning()

      const endpoint = await resolveSpeech()
      if (!endpoint) {
        toast.warning('Text To Speech is not available (no OVMS server or fallback configured)')
        return
      }

      try {
        isSpeaking.value = true
        speakingMessageId.value = id ?? null

        const { bytes, mediaType } = await synthesizeSpeech(trimmed, endpoint)
        const url = bytesToBlobUrl(bytes, mediaType)
        currentObjectUrl = url

        const audio = new Audio(url)
        currentAudio = audio
        audio.onended = () => stopSpeaking()
        audio.onerror = () => stopSpeaking()
        await audio.play()
      } catch (error) {
        console.error('Failed to synthesize speech:', error)
        toast.error(`Failed to play speech: ${error instanceof Error ? error.message : error}`)
        stopSpeaking()
      }
    }

    return {
      enabled,
      initializing,
      selectedEngine,
      selectedKokoroVoice,
      isKokoroAvailable,
      isExternalAvailable,
      available,
      fallback,
      isSpeaking,
      speakingMessageId,
      pendingVoiceTurn,
      hasFallback,
      resolveSpeech,
      toggle,
      initialize,
      ensureSpeechServerRunning,
      ensureKokoroReady,
      synthesizeToWav,
      speak,
      stopSpeaking,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['enabled', 'selectedEngine', 'selectedKokoroVoice', 'fallback'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useTextToSpeech, import.meta.hot))
}
