import { defineStore } from 'pinia'
import { ref } from 'vue'
import { acceptHMRUpdate } from 'pinia'
import { demoAwareStorage } from '../demoAwareStorage'
import { useBackendServices } from './backendServices'
import { useModels } from './models'
import { useDialogStore } from './dialogs'
import * as toast from '@/assets/js/toast'
import { useSetupWizard } from './setupWizard'
import { useProductMode } from './productMode'

export const WHISPER_MODEL_NAME = 'OpenVINO/whisper-base-int8-ov'

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

    /**
     * Resolve which transcription endpoint to use. A configured fallback wins:
     * it is an explicit choice, and it is the only endpoint that works where
     * OVMS is installed but cannot run (macOS, where its binary is not
     * executable). Otherwise the OVMS Whisper server serves transcription.
     * Returns `null` when neither is available.
     */
    async function resolveTranscription(): Promise<TranscriptionEndpoint | null> {
      if (hasFallback()) {
        return {
          baseURL: fallback.value.baseUrl.trim(),
          model: fallback.value.model.trim() || 'whisper-1',
          apiKey: fallback.value.apiKey,
        }
      }

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

      return null
    }

    /**
     * Ensures the transcription server is running when STT is enabled.
     * This method checks if the server is already running and starts it if needed.
     * Unlike initialize(), this method does NOT auto-disable STT on failure.
     */
    async function ensureTranscriptionServerRunning(): Promise<void> {
      if (!enabled.value) return

      // A configured fallback serves transcription, so there is no OVMS server
      // to start — and trying anyway is what used to break STT on hosts where
      // OVMS is installed but cannot execute.
      if (hasFallback()) return

      const openVinoService = backendServices.info.find((s) => s.serviceName === 'openvino-backend')
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
        // A configured fallback needs no local prerequisites: stay enabled and
        // leave OVMS alone.
        if (hasFallback()) return

        // Check OpenVINO backend setup
        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService?.isSetUp) {
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
        // A configured fallback endpoint is the transcription source, whatever
        // state OVMS is in: nothing to install, download or start.
        if (hasFallback()) {
          enabled.value = true
          toast.success('Speech To Text enabled (using fallback transcription endpoint)')
          return
        }

        // Check if OpenVINO backend is installed
        const openVinoService = backendServices.info.find(
          (s) => s.serviceName === 'openvino-backend',
        )

        if (!openVinoService || !openVinoService.isSetUp) {
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
      } else if (hasFallback()) {
        // Nothing was started locally, so turning STT off is just a flag.
        enabled.value = false
        toast.success('Speech To Text disabled')
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

    return {
      enabled,
      initializing,
      fallback,
      hasFallback,
      resolveTranscription,
      toggle,
      initialize,
      ensureTranscriptionServerRunning,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['enabled', 'fallback'],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSpeechToText, import.meta.hot))
}
