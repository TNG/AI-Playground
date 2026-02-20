import { defineStore } from 'pinia'
import { ref } from 'vue'
import { usePresetSwitching } from './presetSwitching'
import { useBackendServices } from './backendServices'
import { useDialogStore } from './dialogs'
import { useGlobalSetup } from './globalSetup'

/**
 * Maps a mode to its corresponding preset categories.
 */
const modeToCategories: Record<ModeType, string[]> = {
  chat: ['chat'],
  imageGen: ['create-images'],
  imageEdit: ['edit-images'],
  video: ['create-videos'],
}

/**
 * Maps a mode to its corresponding preset type.
 */
const modeToPresetType: Record<ModeType, 'chat' | 'comfy'> = {
  chat: 'chat',
  imageGen: 'comfy',
  imageEdit: 'comfy',
  video: 'comfy',
}

export const usePromptStore = defineStore('prompt', () => {
  const currentMode = ref<ModeType>('chat')
  const promptSubmitted = ref(false)

  const submitCallbacks = ref<Partial<Record<ModeType, (prompt: string) => void>>>({})
  const cancelCallbacks = ref<Partial<Record<ModeType, () => void>>>({})

  function getCurrentMode() {
    return currentMode.value
  }

  /**
   * Set the active mode and load the last-used preset for that mode.
   *
   * For modes that require ComfyUI (image generation, image editing, video), this will
   * check whether the comfyui-backend is installed; if it is not, a warning dialog will
   * be shown offering to open the installation manager and the mode switch will be aborted.
   *
   * @param mode - The ModeType to activate; when successful the store's current mode is updated
   *               and the preset orchestrator switches to the last-used preset for the mode.
   */
  function setCurrentMode(mode: ModeType) {
    // Check if ComfyUI is required for this mode
    const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']
    if (comfyUiModes.includes(mode)) {
      const backendServices = useBackendServices()
      const comfyUIService = backendServices.info.find((s) => s.serviceName === 'comfyui-backend')

      if (!comfyUIService?.isSetUp) {
        // ComfyUI is not installed - show dialog
        const dialogStore = useDialogStore()
        const globalSetup = useGlobalSetup()

        const modeNames: Record<ModeType, string> = {
          imageGen: 'Image Generation',
          imageEdit: 'Image Editing',
          video: 'Video Generation',
          chat: 'Chat',
        }

        dialogStore.showWarningDialog(
          `ComfyUI is required for ${modeNames[mode]}. Would you like to install it now?`,
          () => {
            // User confirmed - open installation management
            globalSetup.loadingState = 'manageInstallations'
            dialogStore.closeWarningDialog()
          },
        )
        return // Don't switch mode if ComfyUI is not installed
      }
    }

    const presetSwitching = usePresetSwitching()

    // Set the mode first
    currentMode.value = mode

    // Get categories for this mode
    const categories = modeToCategories[mode]
    const presetType = modeToPresetType[mode]

    // Switch to last-used preset for this mode using orchestrator
    presetSwitching.switchToLastUsedForCategory(categories, presetType, {
      skipModeSwitch: true, // We already set the mode above
    })
  }

  function submitPrompt(promptText: string) {
    const callback = submitCallbacks.value[currentMode.value]
    if (callback) {
      promptSubmitted.value = true
      callback(promptText)
    }
  }

  function cancelProcessing() {
    const callback = cancelCallbacks.value[currentMode.value]
    if (callback) {
      promptSubmitted.value = false
      callback()
    }
  }

  function registerSubmitCallback(mode: ModeType, callback: (prompt: string) => void) {
    submitCallbacks.value[mode] = callback
  }

  function unregisterSubmitCallback(mode: ModeType) {
    delete submitCallbacks.value[mode]
  }

  function registerCancelCallback(mode: ModeType, callback: () => void) {
    cancelCallbacks.value[mode] = callback
  }

  function unregisterCancelCallback(mode: ModeType) {
    delete cancelCallbacks.value[mode]
  }

  /**
   * Set the current mode without triggering preset switching.
   * Used by the preset switching orchestrator when it handles preset selection itself.
   */
  function setModeOnly(mode: ModeType) {
    currentMode.value = mode
  }

  return {
    currentMode,
    promptSubmitted,
    getCurrentMode,
    setCurrentMode,
    setModeOnly,
    submitPrompt,
    cancelProcessing,
    registerSubmitCallback,
    unregisterSubmitCallback,
    registerCancelCallback,
    unregisterCancelCallback,
  }
})