import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'

/** `sessionRef` narrows the Library to the Agents scheduled in that Session. */
export type AgentLibraryView = { agentId?: string; sessionRef?: string; showTrialRun?: boolean }

type OpenLibrary = { kind: 'agent'; view: AgentLibraryView } | { kind: 'model' } | null

function withoutTrialRunRequest(view: AgentLibraryView): AgentLibraryView {
  return { agentId: view.agentId, sessionRef: view.sessionRef }
}

export const useUIStore = defineStore('ui', () => {
  // At most one Library covers the Session; opening one replaces the other, closing returns to it.
  const openLibrary = ref<OpenLibrary>(null)

  const showModelManager = computed(() => openLibrary.value?.kind === 'model')
  const agentLibrary = computed(() =>
    openLibrary.value?.kind === 'agent' ? openLibrary.value.view : null,
  )

  // Per-viewer convenience: a lost value just shows the panel expanded again.
  const sessionsPanelCollapsed = useLocalStorage('aipg.sessionsPanelCollapsed', false)

  function openModelManager() {
    openLibrary.value = { kind: 'model' }
  }

  function closeModelManager() {
    if (showModelManager.value) openLibrary.value = null
  }

  function setAgentLibraryView(view: AgentLibraryView) {
    openLibrary.value = { kind: 'agent', view }
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
    if (agentLibrary.value) openLibrary.value = null
  }

  return {
    sessionsPanelCollapsed,
    showModelManager,
    openModelManager,
    closeModelManager,
    agentLibrary,
    openAgentLibrary,
    selectLibraryAgent,
    trialRunShown,
    clearLibrarySessionFilter,
    closeAgentLibrary,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useUIStore, import.meta.hot))
}
