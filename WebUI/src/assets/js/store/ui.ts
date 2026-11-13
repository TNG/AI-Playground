import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'

/** `sessionRef` narrows the Library to the Agents scheduled in that Session. */
export type AgentLibraryView = { agentId?: string; sessionRef?: string; showTrialRun?: boolean }

type OpenLibrary = { library: 'agent'; view: AgentLibraryView } | { library: 'model' }

export type AppSettingsSection = 'theme'
/** A fresh object per request, so asking for a section again while open scrolls again. */
export type AppSettingsRequest = { section?: { name: AppSettingsSection } }
/** Runs `leave` now, later (after the user confirms), or never (they cancel). */
export type AppSettingsLeaveGuard = (leave: () => void) => void

function withoutTrialRunRequest(view: AgentLibraryView): AgentLibraryView {
  return { agentId: view.agentId, sessionRef: view.sessionRef }
}

export const useUIStore = defineStore('ui', () => {
  // At most one Library covers the Session; opening one replaces the other, closing returns to it.
  // App Settings opens over the Library and closing it returns there; opening a Library closes it.
  const openLibrary = ref<OpenLibrary | null>(null)
  const appSettings = ref<AppSettingsRequest | null>(null)
  // Registered by the dialog, so this store stays free of the theme store's dependencies.
  let appSettingsLeaveGuard: AppSettingsLeaveGuard = (leave) => leave()

  const showModelManager = computed(() => openLibrary.value?.library === 'model')
  const agentLibrary = computed(() =>
    openLibrary.value?.library === 'agent' ? openLibrary.value.view : null,
  )
  /** What the user sees over the Session, whose title-bar button shows pressed. */
  const frontmost = computed<'settings' | OpenLibrary['library'] | null>(() =>
    appSettings.value ? 'settings' : (openLibrary.value?.library ?? null),
  )

  // Per-viewer convenience: a lost value just shows the panel expanded again.
  const sessionsPanelCollapsed = useLocalStorage('aipg.sessionsPanelCollapsed', false)

  /** Returns whether that Library was open. */
  function closeLibrary(library: OpenLibrary['library']): boolean {
    if (openLibrary.value?.library !== library) return false
    openLibrary.value = null
    return true
  }

  function setAppSettingsLeaveGuard(guard: AppSettingsLeaveGuard) {
    appSettingsLeaveGuard = guard
  }

  function leaveAppSettings(then: () => void) {
    if (!appSettings.value) return then()
    appSettingsLeaveGuard(() => {
      appSettings.value = null
      then()
    })
  }

  function openAppSettings(section?: AppSettingsSection) {
    appSettings.value = section ? { section: { name: section } } : {}
  }

  function closeAppSettings() {
    leaveAppSettings(() => {})
  }

  function openModelManager() {
    leaveAppSettings(() => (openLibrary.value = { library: 'model' }))
  }

  function closeModelManager() {
    closeLibrary('model')
  }

  function toggleModelManager() {
    if (appSettings.value || !closeLibrary('model')) openModelManager()
  }

  function setAgentLibraryView(view: AgentLibraryView) {
    openLibrary.value = { library: 'agent', view }
  }

  function openAgentLibrary(view: AgentLibraryView = {}) {
    leaveAppSettings(() => setAgentLibraryView({ ...view }))
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
    if (appSettings.value) leaveAppSettings(() => agentLibrary.value || setAgentLibraryView({}))
    else if (!closeLibrary('agent')) openAgentLibrary()
  }

  return {
    sessionsPanelCollapsed,
    appSettings,
    openAppSettings,
    closeAppSettings,
    setAppSettingsLeaveGuard,
    frontmost,
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
