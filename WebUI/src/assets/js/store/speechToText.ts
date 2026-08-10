import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import { useDialogStore } from './dialogs'
import * as toast from '@/assets/js/toast'
import { useSetupWizard } from './setupWizard'
import { useProductMode } from './productMode'
import {
  DEFAULT_WHISPER_STANDALONE_MODEL,
  type WhisperStandaloneModel,
} from '@/assets/js/whisperConstants'

export const WHISPER_MODEL_NAME = 'OpenVINO/whisper-base-int8-ov'

/** Which engine backs Speech To Text.
 *  - `whisper`: OpenVINO OVMS Whisper server — needs OpenVINO (non-NVIDIA).
 *  - `standalone`: the torch Whisper sidecar (whisper-backend) — works in every mode
 *    (incl. NVIDIA) when its optional backend is installed.
 *  - `external`: an OpenAI-compatible endpoint configured in App Settings — works in
 *    every mode when enabled. */
export type SttEngine = 'whisper' | 'standalone' | 'external'

/**
 * Resolved transcription endpoint configuration consumed by the shared
 * `transcribeAudio` helper. `baseURL` is an OpenAI-compatible base (ending in
 * `/v3` for OVMS or `/v1` for a generic whisper-server); `model` is the model
 * id to request; `apiKey` may be empty for local servers.
 */
export type TranscriptionEndpoint = {
  baseURL: string
  model: string
  apiKey: string
}

/**
 * Configurable fallback transcription endpoint. Used when the OVMS Whisper
 * server is not available (e.g. on macOS, where OVMS does not run). Points at
 * any OpenAI-compatible transcription server — e.g. a local whisper.cpp
 * `whisper-server` started with `--inference-path "/v1/audio/transcriptions"`.
 */
export type SttFallbackConfig = {
  enabled: boolean
  baseUrl: string
  model: string
  apiKey: string
}

export const useSpeechToText = defineStore(
  'speechToText',
  () => {
    const enabled = ref(false)
    const initializing = ref(false)
    // Which engine the STT preset (and mic transcription) uses. Edited in SettingsStt.
    const selectedSttEngine = ref<SttEngine>('whisper')
    // Which model the standalone (torch) Whisper engine uses.
    const selectedStandaloneModel = ref<WhisperStandaloneModel>(DEFAULT_WHISPER_STANDALONE_MODEL)
    // Mirrors `isWhisperBackendEnabled` from settings.json — gates the optional
    // standalone Whisper sidecar (offered in the setup wizard + as an STT engine).
    const isWhisperBackendEnabled = ref(false)
    const backendServices = useBackendServices()
    const models = useModels()
    const dialogStore = useDialogStore()
    const setupWizard = useSetupWizard()
    const productMode = useProductMode()

    /**
     * App-wide fallback transcription endpoint. Shared by both the Home Agent
     * voice-message pipeline and the regular mic-STT path so transcription
     * works even without OVMS installed.
     */
    const fallback = ref<SttFallbackConfig>({
      enabled: false,
      baseUrl: '',
      model: 'whisper-1',
      apiKey: '',
    })

    /** True when a usable fallback endpoint is configured. */
    function hasFallback(): boolean {
      return fallback.value.enabled && fallback.value.baseUrl.trim().length > 0
    }

    /** Whether the OpenVINO Whisper engine can be offered: OpenVINO must be
     *  installable in this product mode (not NVIDIA) and set up. */
    const isWhisperAvailable = computed(() => {
      if (productMode.isNvidiaModeSelected) return false
      const ov = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
      return ov?.isSetUp === true
    })

    /** Whether the external (fallback) transcription endpoint is configured/usable. */
    const isExternalAvailable = computed(() => hasFallback())

    /** Whether the standalone (torch) Whisper engine can be offered: its optional
     *  backend must be installed. Works in every product mode (incl. NVIDIA). */
    const isStandaloneAvailable = computed(() => {
      if (!isWhisperBackendEnabled.value) return false
      const svc = backendServices.info.find((s) => s.serviceName === 'whisper-backend')
      return svc?.isSetUp === true
    })

    /**
     * Whether speech-to-text is usable at all: OpenVINO Whisper (non-NVIDIA), the
     * standalone Whisper backend, or a configured external endpoint. Used to gate the
     * in-chat mic and the STT preset now that the old global STT enable toggle is gone.
     */
    const available = computed(
      () => isWhisperAvailable.value || isStandaloneAvailable.value || isExternalAvailable.value,
    )

    /** Engines offered in the current product mode (mirrors SettingsStt's dropdown):
     *  Whisper (OpenVINO) only off NVIDIA; standalone only when its feature is on;
     *  External always. */
    const offeredSttEngines = computed<SttEngine[]>(() => {
      const list: SttEngine[] = []
      if (!productMode.isNvidiaModeSelected) list.push('whisper')
      if (isWhisperBackendEnabled.value) list.push('standalone')
      list.push('external')
      return list
    })

    /** Best default engine: an installed one first (OpenVINO Whisper → standalone →
     *  external), and only when nothing is installed the highest-priority offered
     *  engine (so External is the default only if neither Whisper is available). */
    const preferredSttEngine = computed<SttEngine>(() => {
      if (isWhisperAvailable.value) return 'whisper'
      if (isStandaloneAvailable.value) return 'standalone'
      if (isExternalAvailable.value) return 'external'
      return offeredSttEngines.value[0] ?? 'external'
    })

    // Keep the selection valid for the current mode/feature flags: when the chosen
    // engine isn't offered (e.g. the persisted 'whisper' default in NVIDIA mode),
    // fall back to the preferred engine. This drives every consumer (mic, tool, STT
    // preset), not just the settings panel.
    watch(
      [offeredSttEngines, selectedSttEngine],
      () => {
        if (!offeredSttEngines.value.includes(selectedSttEngine.value)) {
          selectedSttEngine.value = preferredSttEngine.value
        }
      },
      { immediate: true },
    )

    /**
     * Ensure the standalone Whisper sidecar is ready: its backend must be installed,
     * the selected model present (prompting the download popup if missing), and the
     * service running.
     */
    async function ensureStandaloneReady(): Promise<void> {
      const svc = backendServices.info.find((s) => s.serviceName === 'whisper-backend')
      if (!svc?.isSetUp) {
        throw new Error(
          'The standalone Whisper backend is not installed. Install it from ' +
            'Settings → Installation Management, then try again.',
        )
      }
      const modelExists = await models.checkTranscriptionModelExists(selectedStandaloneModel.value)
      if (!modelExists) {
        const missing = await models.getMissingTranscriptionModel(selectedStandaloneModel.value)
        if (missing.length > 0) {
          await new Promise<void>((resolve, reject) => {
            dialogStore.showDownloadDialog(
              missing,
              () => resolve(),
              () => reject(new Error('Whisper model download was cancelled')),
            )
          })
        }
      }
      if (svc.status !== 'running') {
        await backendServices.startService('whisper-backend')
      }
    }

    /** OpenAI-compatible endpoint for the standalone Whisper sidecar, or null when
     *  its backend isn't running yet. The loopback token is passed as the apiKey so
     *  the shared transcribe helper's `Authorization: Bearer` satisfies the sidecar. */
    async function resolveStandaloneEndpoint(): Promise<TranscriptionEndpoint | null> {
      const svc = backendServices.info.find((s) => s.serviceName === 'whisper-backend')
      const baseUrl = svc?.baseUrl
      if (!baseUrl) return null
      const token = await window.electronAPI.getBackendAuthToken('whisper-backend')
      return {
        baseURL: `${baseUrl.replace(/\/$/, '')}/v1`,
        model: selectedStandaloneModel.value,
        apiKey: token ?? '',
      }
    }

    /**
     * Ensure the OVMS Whisper server is ready to transcribe: OpenVINO must be set up
     * (or a fallback is configured), the model must be present (prompting the
     * standard download popup if missing), and the server must be running. Used by
     * the interactive STT paths (STT preset, mic, transcribeAudio tool) independent
     * of any enable toggle.
     */
    async function ensureWhisperReady(): Promise<void> {
      const openVinoService = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
      if (!openVinoService?.isSetUp) {
        // No OVMS: the fallback endpoint (if any) serves transcription directly.
        if (hasFallback()) return
        throw new Error(
          'OpenVINO backend is required for Speech To Text. Install it from ' +
            'Settings → Installation Management, or configure a fallback endpoint.',
        )
      }

      const modelExists = await models.checkTranscriptionModelExists(WHISPER_MODEL_NAME)
      if (!modelExists) {
        const missing = await models.getMissingTranscriptionModel(WHISPER_MODEL_NAME)
        if (missing.length > 0) {
          await new Promise<void>((resolve, reject) => {
            dialogStore.showDownloadDialog(
              missing,
              () => resolve(),
              () => reject(new Error('Whisper model download was cancelled')),
            )
          })
        }
      }

      const url = await backendServices.getTranscriptionServerUrl()
      if (!url) {
        await backendServices.startTranscriptionServer(WHISPER_MODEL_NAME)
      }
    }

    /**
     * Resolve which transcription endpoint to use. Prefers the OVMS Whisper
     * server when it is running, otherwise falls back to the configured
     * OpenAI-compatible endpoint. Returns `null` when neither is available.
     */
    async function resolveTranscription(): Promise<TranscriptionEndpoint | null> {
      // The standalone engine forces its own torch sidecar.
      if (selectedSttEngine.value === 'standalone') {
        return resolveStandaloneEndpoint()
      }
      // The External engine forces the fallback endpoint; otherwise prefer the OVMS
      // Whisper server when running and fall back to the configured endpoint.
      if (selectedSttEngine.value !== 'external') {
        try {
          const ovmsUrl = await backendServices.getTranscriptionServerUrl()
          if (ovmsUrl) {
            return {
              baseURL: ovmsUrl,
              model: WHISPER_MODEL_NAME.split('/').join('---'),
              apiKey: '',
            }
          }
        } catch (error) {
          console.error('Failed to resolve OVMS transcription server URL:', error)
        }
      }

      if (hasFallback()) {
        return {
          baseURL: fallback.value.baseUrl.trim(),
          model: fallback.value.model.trim() || 'whisper-1',
          apiKey: fallback.value.apiKey,
        }
      }

      return null
    }
    /**
     * Ensures the transcription server is running when STT is enabled.
     * This method checks if the server is already running and starts it if needed.
     * Unlike initialize(), this method does NOT auto-disable STT on failure.
     */
    async function ensureTranscriptionServerRunning(): Promise<void> {
      const openVinoService = backendServices.info.find((s) => s.serviceName === 'openvino-backend')

      // Only start if OVMS is set up. When OVMS is unavailable but a fallback
      // endpoint is configured, transcription is served by the fallback so
      // there is nothing to start here.
      if (!openVinoService?.isSetUp) return

      const modelExists = await models.checkTranscriptionModelExists(WHISPER_MODEL_NAME)
      if (!modelExists) return

      try {
        const url = await backendServices.getTranscriptionServerUrl()
        if (!url) {
          // Server not running, start it
          await backendServices.startTranscriptionServer(WHISPER_MODEL_NAME)
        }
      } catch (error) {
        console.error('Failed to ensure transcription server is running:', error)
      }
    }

    /**
     * Initialize the transcription server on app startup if STT is enabled.
     * This validates all prerequisites and auto-disables STT if they are not met,
     * providing user feedback via toast notifications.
     *
     * This should be called once during app initialization after backends are started.
     */
    async function initialize(): Promise<void> {
      if (productMode.isNvidiaModeSelected) {
        enabled.value = false
        return
      }

      if (!enabled.value) return

      initializing.value = true

      try {
        // Check OpenVINO backend setup
        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService?.isSetUp) {
          // OVMS not installed: keep STT enabled if a fallback endpoint is
          // configured (e.g. on macOS where OVMS does not run), otherwise
          // disable it as before.
          if (hasFallback()) return
          enabled.value = false
          toast.warning('Speech To Text disabled: OpenVINO backend is not installed')
          return
        }

        // Check model exists
        const modelExists = await models.checkTranscriptionModelExists(WHISPER_MODEL_NAME)
        if (!modelExists) {
          enabled.value = false
          toast.warning('Speech To Text disabled: Whisper model not found')
          return
        }

        // Check if server is already running
        const url = await backendServices.getTranscriptionServerUrl()
        if (!url) {
          // Start transcription server
          await backendServices.startTranscriptionServer(WHISPER_MODEL_NAME)
        }
      } catch (error) {
        enabled.value = false
        const errorMessage = error instanceof Error ? error.message : String(error)
        toast.error(`Speech To Text disabled: ${errorMessage}`)
      } finally {
        initializing.value = false
      }
    }

    /**
     * Toggle Speech To Text functionality.
     * Handles all validation, installation checks, model downloads, and server management.
     *
     * @param isEnabled - Whether to enable or disable STT
     * @returns Promise that resolves when the toggle operation is complete
     */
    async function toggle(isEnabled: boolean): Promise<void> {
      if (isEnabled && productMode.isNvidiaModeSelected) {
        return
      }

      if (isEnabled) {
        // Check if OpenVINO backend is installed
        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService || !openVinoService.isSetUp) {
          // Allow enabling STT against the configured fallback endpoint when
          // OVMS is not installed (e.g. macOS dev). Otherwise require OVMS.
          if (hasFallback()) {
            enabled.value = true
            toast.success('Speech To Text enabled (using fallback transcription endpoint)')
            return
          }
          dialogStore.showWarningDialog(
            'OpenVINO backend is required for Speech To Text. Please install it first, or configure a fallback transcription endpoint in Settings.',
            () => {
              setupWizard.openWizard()
            },
          )
          return
        }

        // Check if whisper model exists
        const modelExists = await models.checkTranscriptionModelExists(WHISPER_MODEL_NAME)

        if (!modelExists) {
          // Show download dialog
          const missingModels = await models.getMissingTranscriptionModel(WHISPER_MODEL_NAME)
          if (missingModels.length > 0) {
            dialogStore.showDownloadDialog(
              missingModels,
              async () => {
                // Model downloaded, start transcription server
                try {
                  await backendServices.startTranscriptionServer(WHISPER_MODEL_NAME)
                  enabled.value = true
                  toast.success('Speech To Text enabled')
                } catch (error) {
                  toast.error(`Failed to start transcription server: ${error}`)
                }
              },
              () => {
                // Download failed or cancelled
                toast.warning('Speech To Text requires the whisper model')
              },
            )
            return
          }
        }

        // All requirements met, start transcription server
        try {
          await backendServices.startTranscriptionServer(WHISPER_MODEL_NAME)
          enabled.value = true
          toast.success('Speech To Text enabled')
        } catch (error) {
          toast.error(`Failed to start transcription server: ${error}`)
        }
      } else {
        // Disable Speech To Text
        try {
          await backendServices.stopTranscriptionServer()
          enabled.value = false
          toast.success('Speech To Text disabled')
        } catch (error) {
          toast.error(`Failed to stop transcription server: ${error}`)
        }
      }
    }

    async function initWhisperBackendFlag() {
      try {
        const localSettings = await window.electronAPI.getLocalSettings()
        isWhisperBackendEnabled.value = !!localSettings.isWhisperBackendEnabled
      } catch (e) {
        console.error('speechToText.initWhisperBackendFlag failed:', e)
        isWhisperBackendEnabled.value = false
      }
    }
    void initWhisperBackendFlag()

    return {
      enabled,
      initializing,
      fallback,
      selectedSttEngine,
      selectedStandaloneModel,
      isWhisperBackendEnabled,
      isWhisperAvailable,
      isStandaloneAvailable,
      isExternalAvailable,
      available,
      hasFallback,
      resolveTranscription,
      ensureStandaloneReady,
      toggle,
      initialize,
      ensureTranscriptionServerRunning,
      ensureWhisperReady,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['enabled', 'fallback', 'selectedSttEngine', 'selectedStandaloneModel'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSpeechToText, import.meta.hot))
}
