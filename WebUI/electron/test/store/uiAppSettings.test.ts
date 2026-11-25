import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUIStore } from '@/assets/js/store/ui'

/** Stands in for unsaved theme colours: every close waits for a confirm or cancel. */
function holdUnsavedChanges(ui: ReturnType<typeof useUIStore>) {
  let pending: (() => void) | null = null
  ui.setThemePanelLeaveGuard((leave) => (pending = leave))
  return {
    get asking() {
      return pending !== null
    },
    confirm() {
      pending?.()
      pending = null
    },
    cancel() {
      pending = null
    },
  }
}

describe('App Settings and the Agent Library', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens App Settings over the Agent Library and returns to it on close', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1' })

    ui.openAppSettings()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.agentLibrary).toEqual({ agentId: 't1' })
    expect(ui.frontmost).toBe('settings')

    ui.closeAppSettings()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.agentLibrary).toEqual({ agentId: 't1' })
    expect(ui.frontmost).toBe('agent')
  })

  it('reveals the Agent Library under App Settings, as it was, when its button is clicked', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1', sessionRef: 's1' })
    ui.openAppSettings()

    ui.toggleAgentLibrary()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.agentLibrary).toEqual({ agentId: 't1', sessionRef: 's1' })
  })

  it('opens the Model Library over the Agent Library, which stays underneath', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1' })

    ui.toggleModelLibrary()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.appSettingsTab).toBe('models')
    expect(ui.frontmost).toBe('models')
    expect(ui.agentLibrary).toEqual({ agentId: 't1' })
  })

  it('names nothing frontmost while the Session shows', () => {
    expect(useUIStore().frontmost).toBeNull()
  })

  it('closes App Settings when the Agent Library button is clicked', () => {
    const ui = useUIStore()
    ui.openAppSettings()

    ui.toggleAgentLibrary()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.agentLibrary).toEqual({})
  })

  it('returns to the Session when App Settings closes', () => {
    const ui = useUIStore()
    ui.openAppSettings()

    ui.closeAppSettings()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.agentLibrary).toBeNull()
  })
})

describe('The Model Library tab', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens App Settings on the Model Library tab from its button', () => {
    const ui = useUIStore()

    ui.toggleModelLibrary()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.appSettingsTab).toBe('models')
    expect(ui.frontmost).toBe('models')
  })

  it('closes App Settings when its pressed button is clicked again', () => {
    const ui = useUIStore()
    ui.toggleModelLibrary()

    ui.toggleModelLibrary()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.frontmost).toBeNull()
  })

  it('switches to the Model Library tab when its button is clicked over another tab', () => {
    const ui = useUIStore()
    ui.toggleAppSettings()

    ui.toggleModelLibrary()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.appSettingsTab).toBe('models')
  })

  it('switches to the App tab when the gear is clicked over the Model Library', () => {
    const ui = useUIStore()
    ui.toggleModelLibrary()

    ui.toggleAppSettings()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.appSettingsTab).toBe('app')
    expect(ui.frontmost).toBe('settings')
  })

  it('names App Settings frontmost on any tab but the Model Library', () => {
    const ui = useUIStore()
    ui.openAppSettings()

    ui.setAppSettingsTab('components')

    expect(ui.frontmost).toBe('settings')
  })

  it('opens on the App tab again after the Model Library was last shown', () => {
    const ui = useUIStore()
    ui.openModelLibrary()
    ui.closeAppSettings()

    ui.openAppSettings()

    expect(ui.appSettingsTab).toBe('app')
  })
})

describe('The theme panel', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens beside whatever is shown, leaving the Agent Library open', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1' })

    ui.openThemePanel()

    expect(ui.themePanelOpen).toBe(true)
    expect(ui.agentLibrary).toEqual({ agentId: 't1' })
  })

  it('closes App Settings when opened from there', () => {
    const ui = useUIStore()
    ui.openAppSettings()

    ui.openThemePanel()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.themePanelOpen).toBe(true)
  })

  it('closes without asking when nothing is unsaved', () => {
    const ui = useUIStore()
    ui.openThemePanel()

    ui.closeThemePanel()

    expect(ui.themePanelOpen).toBe(false)
  })

  it('asks before closing with unsaved changes, and stays open when cancelled', () => {
    const ui = useUIStore()
    ui.openThemePanel()
    const unsaved = holdUnsavedChanges(ui)

    ui.closeThemePanel()

    expect(unsaved.asking).toBe(true)
    expect(ui.themePanelOpen).toBe(true)

    unsaved.cancel()

    expect(ui.themePanelOpen).toBe(true)
  })

  it('closes once discarding unsaved changes is confirmed', () => {
    const ui = useUIStore()
    ui.openThemePanel()
    const unsaved = holdUnsavedChanges(ui)

    ui.closeThemePanel()
    unsaved.confirm()

    expect(ui.themePanelOpen).toBe(false)
  })

  it('does not ask to close a panel that is not open', () => {
    const ui = useUIStore()
    const unsaved = holdUnsavedChanges(ui)

    ui.closeThemePanel()

    expect(unsaved.asking).toBe(false)
  })
})

describe('The Component Manager tab', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens App Settings on the Component Manager tab from the header button', () => {
    const ui = useUIStore()

    ui.toggleComponentManager()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.appSettingsTab).toBe('components')
    expect(ui.componentManagerShowing).toBe(true)
  })

  it('closes App Settings when its pressed button is clicked again', () => {
    const ui = useUIStore()
    ui.toggleComponentManager()

    ui.toggleComponentManager()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.componentManagerShowing).toBe(false)
  })

  it('switches to the Component Manager tab when its button is clicked over another tab', () => {
    const ui = useUIStore()
    ui.openAppSettings('app')

    ui.toggleComponentManager()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.appSettingsTab).toBe('components')
    expect(ui.componentManagerShowing).toBe(true)
  })

  it('is not pressed while another App Settings tab or no dialog shows', () => {
    const ui = useUIStore()

    expect(ui.componentManagerShowing).toBe(false)

    ui.openAppSettings('app')

    expect(ui.componentManagerShowing).toBe(false)

    ui.openModelLibrary()

    expect(ui.componentManagerShowing).toBe(false)
  })
})

describe('The Component Manager sub-views', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens the Channels setup inside the tab from the title-bar gear', () => {
    const ui = useUIStore()

    ui.openComponentManagerChannels()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.appSettingsTab).toBe('components')
    expect(ui.componentManagerSubView).toBe('channels')
    expect(ui.componentManagerShowing).toBe(true)
  })

  it('opens the Channels setup inside the tab from the Permissions link over the App tab', () => {
    const ui = useUIStore()
    ui.openAppSettings('app')

    ui.openComponentManagerChannels()

    expect(ui.appSettingsTab).toBe('components')
    expect(ui.componentManagerSubView).toBe('channels')
  })

  it('opens the Hybrid Cloud provider setup inside the tab', () => {
    const ui = useUIStore()

    ui.openComponentManagerCloud()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.appSettingsTab).toBe('components')
    expect(ui.componentManagerSubView).toBe('cloud')
  })

  it('returns to the Component list when a sub-view closes, leaving the tab open', () => {
    const ui = useUIStore()
    ui.openComponentManagerChannels()

    ui.closeComponentManagerSubView()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.appSettingsTab).toBe('components')
    expect(ui.componentManagerSubView).toBeNull()
  })

  it('shows the Component list again when the tab is reopened from the header', () => {
    const ui = useUIStore()
    ui.openComponentManagerChannels()

    ui.toggleComponentManager()
    ui.toggleComponentManager()

    expect(ui.appSettingsOpen).toBe(true)
    expect(ui.componentManagerSubView).toBeNull()
  })

  it('leaves a sub-view when another App Settings tab is shown', () => {
    const ui = useUIStore()
    ui.openComponentManagerChannels()

    ui.setAppSettingsTab('models')

    expect(ui.componentManagerSubView).toBeNull()
  })
})
