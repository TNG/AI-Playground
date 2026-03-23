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

type ExplicitDefaultsState = 'idle' | 'applying' | 'applied'

type DriverJsComponent = {
  triggerFirstTimeHelp: (buttonId: DemoButtonId) => void
}

let driverJsRef: DriverJsComponent | null = null

export const useDemoMode = defineStore('demoMode', () => {
  const enabled = ref(false)
  const explicitDefaultsState = ref<ExplicitDefaultsState>('idle')
  const visitedButtons = ref<Record<DemoButtonId, boolean>>(createInitialVisitedState())
  const showResetDialog = ref(false)

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

  // --- User activity detection ---

  let resetTimer: null | ReturnType<typeof setTimeout> = null
  let trackUserInteractionInterval: null | ReturnType<typeof setInterval> = null
  // Sticky user activation (navigator.userActivation.hasBeenActive) is not reset by location.reload()
  // in Chromium/Electron — it is tied to the Window and never clears. Track interaction since this
  // page load ourselves so the reset timer only starts after a real user gesture post-reload.
  let userInteractedThisLoad = false

  const USER_IDLE_THRESHOLD_MS = 5000
  let lastMouseMove = 0
  function isUserActive(): boolean {
    return navigator.userActivation.isActive || Date.now() - lastMouseMove < USER_IDLE_THRESHOLD_MS
  }

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
        window.addEventListener('mousemove', () => (lastMouseMove = Date.now()))
      }, GRACE_MS)
      console.log('trackUserInteraction')
      trackUserInteraction()
    }
  })

  const showDemoToggle = computed(() => hasPasscode.value)

  function resetDemo() {
    sessionStorage.clear()
    location.reload()
  }

  const trackUserInteraction = () => {
    if (trackUserInteractionInterval) {
      clearInterval(trackUserInteractionInterval)
      trackUserInteractionInterval = null
    }
    trackUserInteractionInterval = setInterval(() => {
      // console.log('interaction any/recent:', userInteractedThisLoad, isUserActive())
      if (!userInteractedThisLoad) return
      if (isUserActive()) {
        if (resetTimer) {
          clearTimeout(resetTimer)
          resetTimer = null
        }
      } else {
        if (!resetTimer && resetInSeconds.value && !showResetDialog.value) {
          console.log(
            `demo mode reset timer started, resetting after ${resetInSeconds.value} seconds`,
          )
          resetTimer = setTimeout(() => {
            resetTimer = null
            showResetDialog.value = true
          }, resetInSeconds.value * 1000)
        }
      }
    }, 1000)
  }

  function cancelReset() {
    showResetDialog.value = false
  }

  async function applyExplicitDefaults() {
    if (!enabled.value || explicitDefaultsState.value !== 'idle') return

    explicitDefaultsState.value = 'applying'
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      await applyDemoModeExplicitDefaults()
    } finally {
      explicitDefaultsState.value = 'applied'
    }
  }

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
    showResetDialog,
    isVisited,
    registerDriverJs,
    triggerFirstTimeHelp,
    applyExplicitDefaults,
    verifyPasscode,
    setEnabled,
    cancelReset,
    resetDemo,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDemoMode, import.meta.hot))
}
