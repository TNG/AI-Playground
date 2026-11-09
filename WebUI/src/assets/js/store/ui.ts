import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'

/** `sessionRef` narrows the Library to the Agents scheduled in that Session. */
export type AgentLibraryView = { agentId?: string; sessionRef?: string }

export const useUIStore = defineStore('ui', () => {
  // Model management overlay. Deliberately not tied to `promptArea.currentMode`:
  // closing it should return the user to exactly the view they were in.
  const showModelManager = ref(false)

  // The Agent Library overlay, open over whatever Session is showing; `agentId` is the selected Agent.
  const agentLibrary = ref<AgentLibraryView | null>(null)

  // Per-viewer convenience: a lost value just shows the panel expanded again.
  const sessionsPanelCollapsed = useLocalStorage('aipg.sessionsPanelCollapsed', false)

  function openModelManager() {
    showModelManager.value = true
  }

  function closeModelManager() {
    showModelManager.value = false
  }

  function openAgentLibrary(view: AgentLibraryView = {}) {
    agentLibrary.value = { ...view }
  }

  function selectLibraryAgent(agentId: string | undefined) {
    if (agentLibrary.value) agentLibrary.value = { ...agentLibrary.value, agentId }
  }

  function clearLibrarySessionFilter() {
    if (agentLibrary.value) agentLibrary.value = { agentId: agentLibrary.value.agentId }
  }

  function closeAgentLibrary() {
    agentLibrary.value = null
  }

  return {
    sessionsPanelCollapsed,
    showModelManager,
    openModelManager,
    closeModelManager,
    agentLibrary,
    openAgentLibrary,
    selectLibraryAgent,
    clearLibrarySessionFilter,
    closeAgentLibrary,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUIStore, import.meta.hot))
}
