import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type LeftPanel = 'history'

export const useUIStore = defineStore('ui', () => {
  const leftPanel = ref<LeftPanel | null>(null)
  const showHistory = computed(() => leftPanel.value === 'history')

  // Model management overlay. Deliberately not tied to `promptArea.currentMode`:
  // closing it should return the user to exactly the view they were in.
  const showModelManager = ref(false)

  // The right-hand settings sidebar of the current mode.
  const showSettings = ref(false)

  function openHistory() {
    leftPanel.value = 'history'
  }

  function closeHistory() {
    if (leftPanel.value === 'history') leftPanel.value = null
  }

  function openSettings() {
    showSettings.value = true
  }

  function closeSettings() {
    showSettings.value = false
  }

  function openModelManager() {
    showModelManager.value = true
  }

  function closeModelManager() {
    showModelManager.value = false
  }

  return {
    leftPanel,
    showHistory,
    openHistory,
    closeHistory,
    showSettings,
    openSettings,
    closeSettings,
    showModelManager,
    openModelManager,
    closeModelManager,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUIStore, import.meta.hot))
}
