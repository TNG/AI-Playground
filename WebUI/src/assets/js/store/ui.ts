import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useLocalStorage } from '@vueuse/core'

/** `sessionRef` narrows the Library to the Agents scheduled in that Session. */
export type AgentLibraryView = { agentId?: string; sessionRef?: string; showTrialRun?: boolean }

export type AppSettingsTab = 'app' | 'components' | 'models'

/** The setup screens the Component Manager shows in place of its list. */
export type ComponentManagerSubView = 'channels' | 'cloud'

/** The surface over the Session whose title-bar button shows pressed. */
export type FrontmostSurface = 'settings' | 'models' | 'agent'

/** Runs `leave` now, later (after the user confirms), or never (they cancel). */
export type LeaveGuard = (leave: () => void) => void

function withoutTrialRunRequest(view: AgentLibraryView): AgentLibraryView {
  return { agentId: view.agentId, sessionRef: view.sessionRef }
}

export const useUIStore = defineStore('ui', () => {
  // App Settings opens over the Agent Library and closing it returns there; opening it closes them.
  const agentLibraryView = ref<AgentLibraryView | null>(null)
  const appSettingsOpen = ref(false)
  const appSettingsTab = ref<AppSettingsTab>('app')
  const componentManagerSubView = ref<ComponentManagerSubView | null>(null)
  // The theme panel docks beside everything above rather than covering it.
  const themePanelOpen = ref(false)
  // Registered by the panel, so this store stays free of the theme store's dependencies.
  let themePanelLeaveGuard: LeaveGuard = (leave) => leave()

  const agentLibrary = computed(() => agentLibraryView.value)
  const componentManagerShowing = computed(
    () => appSettingsOpen.value && appSettingsTab.value === 'components',
  )
  const frontmost = computed<FrontmostSurface | null>(() => {
    if (appSettingsOpen.value) return appSettingsTab.value === 'models' ? 'models' : 'settings'
    return agentLibraryView.value ? 'agent' : null
  })

  // Per-viewer convenience: a lost value just shows the panel expanded again.
  const sessionsPanelCollapsed = useLocalStorage('aipg.sessionsPanelCollapsed', false)

  function openAppSettings(tab: AppSettingsTab = 'app') {
    appSettingsTab.value = tab
    if (tab !== 'components') componentManagerSubView.value = null
    appSettingsOpen.value = true
  }

  function setAppSettingsTab(tab: AppSettingsTab) {
    appSettingsTab.value = tab
    if (tab !== 'components') componentManagerSubView.value = null
  }

  /** The gear's toggle: pressed only while App Settings shows a tab other than the Model Library. */
  function toggleAppSettings() {
    if (frontmost.value === 'settings') closeAppSettings()
    else openAppSettings()
  }

  function closeAppSettings() {
    appSettingsOpen.value = false
  }

  function openThemePanel() {
    closeAppSettings()
    themePanelOpen.value = true
  }

  function setThemePanelLeaveGuard(guard: LeaveGuard) {
    themePanelLeaveGuard = guard
  }

  function closeThemePanel() {
    if (themePanelOpen.value) themePanelLeaveGuard(() => (themePanelOpen.value = false))
  }

  function openModelLibrary() {
    openAppSettings('models')
  }

  function toggleModelLibrary() {
    if (frontmost.value === 'models') closeAppSettings()
    else openModelLibrary()
  }

  function openComponentManager(subView: ComponentManagerSubView | null = null) {
    appSettingsOpen.value = true
    appSettingsTab.value = 'components'
    componentManagerSubView.value = subView
  }

  function openComponentManagerChannels() {
    openComponentManager('channels')
  }

  function openComponentManagerCloud() {
    openComponentManager('cloud')
  }

  function closeComponentManagerSubView() {
    componentManagerSubView.value = null
  }

  function toggleComponentManager() {
    if (componentManagerShowing.value) closeAppSettings()
    else openComponentManager()
  }

  function setAgentLibraryView(view: AgentLibraryView) {
    agentLibraryView.value = view
  }

  function openAgentLibrary(view: AgentLibraryView = {}) {
    closeAppSettings()
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
    agentLibraryView.value = null
  }

  function toggleAgentLibrary() {
    if (appSettingsOpen.value) {
      closeAppSettings()
      if (!agentLibrary.value) setAgentLibraryView({})
    } else if (agentLibrary.value) closeAgentLibrary()
    else openAgentLibrary()
  }

  return {
    sessionsPanelCollapsed,
    appSettingsOpen,
    appSettingsTab,
    openAppSettings,
    setAppSettingsTab,
    toggleAppSettings,
    closeAppSettings,
    themePanelOpen,
    openThemePanel,
    closeThemePanel,
    setThemePanelLeaveGuard,
    frontmost,
    componentManagerShowing,
    componentManagerSubView,
    openModelLibrary,
    toggleModelLibrary,
    openComponentManager,
    openComponentManagerChannels,
    openComponentManagerCloud,
    closeComponentManagerSubView,
    toggleComponentManager,
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
