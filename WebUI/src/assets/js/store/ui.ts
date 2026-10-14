import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'

export type LeftPanel = 'history' | 'tasks'

export const useUIStore = defineStore('ui', () => {
  const leftPanel = ref<LeftPanel | null>(null)
  const showHistory = computed(() => leftPanel.value === 'history')
  const showTasks = computed(() => leftPanel.value === 'tasks')

  // Model management overlay. Deliberately not tied to `promptArea.currentMode`:
  // closing it should return the user to exactly the view they were in.
  const showModelManager = ref(false)

  function openHistory() {
    leftPanel.value = 'history'
  }

  function closeHistory() {
    if (leftPanel.value === 'history') leftPanel.value = null
  }

  function openTasks() {
    leftPanel.value = 'tasks'
  }

  function closeTasks() {
    if (leftPanel.value === 'tasks') leftPanel.value = null
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
    showTasks,
    openTasks,
    closeTasks,
    showModelManager,
    openModelManager,
    closeModelManager,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUIStore, import.meta.hot))
}
