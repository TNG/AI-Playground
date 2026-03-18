import { acceptHMRUpdate, defineStore } from 'pinia'
import { applyDemoModeExplicitDefaults } from './demoModeDefaults'

export type DemoButtonId =
  | 'mode-button-chat'
  | 'mode-button-imageGen'
  | 'mode-button-imageEdit'
  | 'mode-button-video'
  | 'camera-button'
  | 'microphone-button'
  | 'app-settings-button'
  | 'advanced-settings-button'
  | 'plus-icon'

export const initiallyUnvisitedDemoButtonIds: DemoButtonId[] = [
  'mode-button-chat',
  'mode-button-imageGen',
  'mode-button-imageEdit',
  'camera-button',
  'microphone-button',
  'app-settings-button',
  'advanced-settings-button',
  'plus-icon',
]

function createInitialVisitedState(): Record<DemoButtonId, boolean> {
  const state = Object.fromEntries(
    initiallyUnvisitedDemoButtonIds.map((id) => [id, false]),
  ) as Record<DemoButtonId, boolean>
  // Video mode is disabled during demo, so no notification dot
  state['mode-button-video'] = true
  return state
}

const chatInitial = {
  show: false,
  finished: false,
}
const imageGenInitial = {
  show: false,
  finished: false,
}
const videoInitial = {
  show: false,
  finished: false,
}
type ImageEditFeature = 'upscale' | 'prompt' | 'inpaint' | 'outpaint'
const imageEditInitial = {
  showUpscale: false,
  showPrompt: false,
  showInpaint: false,
  showOutpaint: false,
  finishedUpscale: false,
  finishedPrompt: false,
  finishedInpaint: false,
  finishedOutpaint: false,
  feature: 'upscale' as ImageEditFeature,
  imageAvailable: false,
  show: false,
  finished: false,
}

type ExplicitDefaultsState = 'idle' | 'applying' | 'applied'

type DriverJsComponent = {
  triggerFirstTimeHelp: (buttonId: DemoButtonId) => void
}

let driverJsRef: DriverJsComponent | null = null

export const useDemoMode = defineStore('demoMode', () => {
  const enabled = ref(false)
  const explicitDefaultsState = ref<ExplicitDefaultsState>('idle')
  const visitedButtons = ref<Record<DemoButtonId, boolean>>(createInitialVisitedState())

  function markAsVisited(buttonId: DemoButtonId) {
    visitedButtons.value[buttonId] = true
  }

  function isVisited(buttonId: DemoButtonId): boolean {
    return visitedButtons.value[buttonId]
  }

  function registerDriverJs(ref: DriverJsComponent) {
    driverJsRef = ref
  }

  function triggerFirstTimeHelp(buttonId: DemoButtonId): boolean {
    if (!enabled.value) return false
    if (isVisited(buttonId)) return false
    markAsVisited(buttonId)
    driverJsRef?.triggerFirstTimeHelp(buttonId)
    return true
  }

  let resetTimer: null | ReturnType<typeof setTimeout> = null
  let trackUserInteractionInterval: null | ReturnType<typeof setInterval> = null
  // Sticky user activation (navigator.userActivation.hasBeenActive) is not reset by location.reload()
  // in Chromium/Electron — it is tied to the Window and never clears. Track interaction since this
  // page load ourselves so the reset timer only starts after a real user gesture post-reload.
  let userInteractedThisLoad = false

  const resetInSeconds = ref<null | number>(null)
  const passcode = ref('')
  const hasPasscode = computed(() => passcode.value.length > 0)
  window.electronAPI.getDemoModeSettings().then((res) => {
    enabled.value = res.isDemoModeEnabled
    resetInSeconds.value = res.demoModeResetInSeconds
    passcode.value = res.demoModePasscode ?? ''
    if (res.isDemoModeEnabled && res.demoModeResetInSeconds) {
      const markInteracted = (e: Event) => {
        console.log('markInteracted', e.isTrusted)
        if (e.isTrusted) userInteractedThisLoad = true
      }
      // Delay attaching listeners so load/focus spurious events don't start the reset timer
      const GRACE_MS = 1000
      window.setTimeout(() => {
        console.log('markInteracted listener added')
        window.addEventListener('click', markInteracted, { capture: true, once: true })
        window.addEventListener('keydown', markInteracted, { capture: true, once: true })
      }, GRACE_MS)
      console.log('trackUserInteraction')
      trackUserInteraction()
    }
  })

  const showDemoToggle = computed(() => hasPasscode.value)

  const chat = ref(chatInitial)
  const imageGen = ref(imageGenInitial)
  const imageEdit = ref(imageEditInitial)
  const video = ref(videoInitial)

  const trackUserInteraction = () => {
    if (trackUserInteractionInterval) {
      clearInterval(trackUserInteractionInterval)
      trackUserInteractionInterval = null
    }
    trackUserInteractionInterval = setInterval(() => {
      if (!userInteractedThisLoad) return
      if (navigator.userActivation.isActive) {
        if (resetTimer) {
          clearTimeout(resetTimer)
          resetTimer = null
        }
      } else {
        if (!resetTimer && resetInSeconds.value) {
          console.log(
            `demo mode reset timer started, resetting after ${resetInSeconds.value} seconds`,
          )
          resetTimer = setTimeout(() => {
            if (trackUserInteractionInterval) {
              clearInterval(trackUserInteractionInterval)
              trackUserInteractionInterval = null
            }
            resetTimer = null
            sessionStorage.clear()
            location.reload()
          }, resetInSeconds.value * 1000)
        }
      }
    }, 1000)
  }

  const escapeDemo = (e: Event) => {
    e.stopPropagation()
    imageGen.value.show = false
    imageEdit.value.show = false
    chat.value.show = false
    video.value.show = false
  }

  async function applyExplicitDefaults() {
    if (!enabled.value || explicitDefaultsState.value !== 'idle') return

    explicitDefaultsState.value = 'applying'
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const defaults = await applyDemoModeExplicitDefaults()
      imageEdit.value.feature = defaults.imageEditFeature
    } finally {
      explicitDefaultsState.value = 'applied'
    }
  }

  watch(
    [
      () => chat.value.show,
      () => imageGen.value.show,
      () => imageEdit.value.show,
      () => video.value.show,
    ],
    ([c, g, e, v]) => {
      if (c || g || e || v) {
        setTimeout(() => document.addEventListener('click', escapeDemo), 50)
      } else {
        document.removeEventListener('click', escapeDemo)
      }
    },
  )

  function verifyPasscode(input: string): boolean {
    return input === passcode.value
  }

  async function setEnabled(value: boolean) {
    try {
      const result = await window.electronAPI.updateLocalSettings({ isDemoModeEnabled: value })
      if (result.success) {
        enabled.value = value
        console.log(`Demo mode ${value ? 'enabled' : 'disabled'}. Reloading...`)
        setTimeout(() => location.reload(), 1000)
      } else {
        console.error('Failed to update demo mode setting')
      }
    } catch (error) {
      console.error('Failed to toggle demo mode:', error)
    }
  }

  return {
    enabled,
    showDemoToggle,
    hasPasscode,
    chat,
    imageGen,
    imageEdit,
    video,
    visitedButtons,
    markAsVisited,
    isVisited,
    registerDriverJs,
    triggerFirstTimeHelp,
    applyExplicitDefaults,
    verifyPasscode,
    setEnabled,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDemoMode, import.meta.hot))
}
