import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'

/** `sessionRef` narrows the Library to the Agents scheduled in that Session. */
export type AgentLibraryView = { agentId?: string; sessionRef?: string; showTrialRun?: boolean }

type OpenLibrary = { library: 'agent'; view: AgentLibraryView } | { library: 'model' }

function withoutTrialRunRequest(view: AgentLibraryView): AgentLibraryView {
  return { agentId: view.agentId, sessionRef: view.sessionRef }
}

export const useUIStore = defineStore('ui', () => {
  // At most one Library covers the Session; opening one replaces the other, closing returns to it.
  const openLibrary = ref<OpenLibrary | null>(null)

  const showModelManager = computed(() => openLibrary.value?.library === 'model')
  const agentLibrary = computed(() =>
    openLibrary.value?.library === 'agent' ? openLibrary.value.view : null,
  )

  // Per-viewer convenience: a lost value just shows the panel expanded again.
  const sessionsPanelCollapsed = useLocalStorage('aipg.sessionsPanelCollapsed', false)

  /** Returns whether that Library was open. */
  function closeLibrary(library: OpenLibrary['library']): boolean {
    if (openLibrary.value?.library !== library) return false
    openLibrary.value = null
    return true
  }

  function openModelManager() {
    openLibrary.value = { library: 'model' }
  }

  function closeModelManager() {
    closeLibrary('model')
  }

  function toggleModelManager() {
    if (!closeLibrary('model')) openModelManager()
  }

  function setAgentLibraryView(view: AgentLibraryView) {
    openLibrary.value = { library: 'agent', view }
  }

  function openAgentLibrary(view: AgentLibraryView = {}) {
    setAgentLibraryView({ ...view })
  }

  function selectLibraryAgent(agentId: string | undefined) {
    if (!agentLibrary.value) return
    setAgentLibraryView({ ...withoutTrialRunRequest(agentLibrary.value), agentId })
  }

  function trialRunShown() {
    if (agentLibrary.value) setAgentLibraryView(withoutTrialRunRequest(agentLibrary.value))
  }

  function clearLibrarySessionFilter() {
    if (agentLibrary.value) setAgentLibraryView({ agentId: agentLibrary.value.agentId })
  }

  function closeAgentLibrary() {
    closeLibrary('agent')
  }

  function toggleAgentLibrary() {
    if (!closeLibrary('agent')) openAgentLibrary()
  }

  return {
    sessionsPanelCollapsed,
    showModelManager,
    openModelManager,
    closeModelManager,
    toggleModelManager,
    agentLibrary,
    openAgentLibrary,
    selectLibraryAgent,
    trialRunShown,
    clearLibrarySessionFilter,
    closeAgentLibrary,
    toggleAgentLibrary,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUIStore, import.meta.hot))
}
