import { acceptHMRUpdate, defineStore } from 'pinia'
import { applyDemoModeExplicitDefaults } from './demoModeDefaults'

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
export const useDemoMode = defineStore('demoMode', () => {
  const enabled = ref(false)
  const explicitDefaultsApplied = ref(false)
  const explicitDefaultsApplying = ref(false)

  let resetTimer: null | ReturnType<typeof setTimeout> = null
  let trackUserInteractionInterval: null | ReturnType<typeof setInterval> = null

  const resetInSeconds = ref<null | number>(null)
  window.electronAPI.getDemoModeSettings().then((res) => {
    enabled.value = res.isDemoModeEnabled
    resetInSeconds.value = res.demoModeResetInSeconds
    if (res.isDemoModeEnabled && res.demoModeResetInSeconds) trackUserInteraction()
  })

  const chat = ref(chatInitial)
  const imageGen = ref(imageGenInitial)
  const imageEdit = ref(imageEditInitial)
  const video = ref(videoInitial)

  const pages = {
    chat,
    imageGen,
    imageEdit,
    video,
  }

  const trackUserInteraction = () => {
    if (trackUserInteractionInterval) {
      clearInterval(trackUserInteractionInterval)
      trackUserInteractionInterval = null
    }
    trackUserInteractionInterval = setInterval(() => {
      if (!navigator.userActivation.hasBeenActive) return
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

  function calculateMaskPenDim() {
    const maskPenRef = document.getElementById('mask-pen')?.getBoundingClientRect()

    if (maskPenRef) {
      setTimeout(() => {
        const inpaintOverlayContent = document.getElementById('inpaintOverlayContent')
        if (inpaintOverlayContent && inpaintOverlayContent.style) {
          inpaintOverlayContent.style.top = `${maskPenRef.bottom - 145}px`
          inpaintOverlayContent.style.left = `${maskPenRef.left - 445}px`
        }
      }, 50)
    }
  }

  function triggerHelp(page: DemoModePage, force = false) {
    if (!enabled.value) return
    console.log('demo mode triggered for ', {
      page,
      force,
    })
    if (!force && pages[page].value.finished) return
    if (page !== 'imageEdit') {
      pages[page].value.show = true
      pages[page].value.finished = true
    } else {
      switch (imageEdit.value.feature) {
        case 'upscale':
          if (imageEdit.value.finishedUpscale && !force) break
          imageEdit.value.showUpscale = true
          imageEdit.value.finishedUpscale = true
          pages[page].value.show = true
          break
        case 'prompt':
          if (imageEdit.value.finishedPrompt && !force) break
          imageEdit.value.showPrompt = true
          imageEdit.value.finishedPrompt = true
          pages[page].value.show = true
          break
        case 'inpaint':
          if (!imageEdit.value.imageAvailable) break
          if (imageEdit.value.finishedInpaint && !force) return
          setTimeout(() => {
            const maskPenRef: HTMLElement = document.getElementById('mask-pen') as HTMLElement
            const isMaskPenVisible = window.getComputedStyle(maskPenRef).display !== 'none'
            if (isMaskPenVisible) {
              imageEdit.value.showInpaint = true
              imageEdit.value.finishedInpaint = true
              pages[page].value.show = true
              calculateMaskPenDim()
            }
          }, 100)
          break
        case 'outpaint':
          if (imageEdit.value.finishedOutpaint && !force) break
          imageEdit.value.showOutpaint = true
          imageEdit.value.finishedOutpaint = true
          pages[page].value.show = true
          break
      }
    }
  }

  async function applyExplicitDefaults() {
    if (!enabled.value || explicitDefaultsApplied.value || explicitDefaultsApplying.value) return

    explicitDefaultsApplying.value = true
    try {
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const defaults = await applyDemoModeExplicitDefaults()
      imageEdit.value.feature = defaults.imageEditFeature
      explicitDefaultsApplied.value = true
    } finally {
      explicitDefaultsApplying.value = false
    }
  }

  watch(
    () => imageEdit.value.show,
    (showImageEdit) => {
      if (!showImageEdit) {
        imageEdit.value.showUpscale = false
        imageEdit.value.showPrompt = false
        imageEdit.value.showInpaint = false
        imageEdit.value.showOutpaint = false
      }
    },
  )

  watch(
    () => imageEdit.value.feature,
    () => {
      if (!enabled.value) return
      if (!imageEdit.value.show) triggerHelp('imageEdit')
    },
  )

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

  return {
    enabled,
    chat,
    imageGen,
    imageEdit,
    video,
    applyExplicitDefaults,
    triggerHelp,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDemoMode, import.meta.hot))
}
