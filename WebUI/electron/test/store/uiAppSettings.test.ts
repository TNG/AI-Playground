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

describe('App Settings and the Libraries', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens App Settings over the open Library and returns to it on close', () => {
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

  it('reveals the Library under App Settings, as it was, when its button is clicked', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1', sessionRef: 's1' })
    ui.openAppSettings()

    ui.toggleAgentLibrary()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.agentLibrary).toEqual({ agentId: 't1', sessionRef: 's1' })
  })

  it('switches from App Settings over one Library to the other Library', () => {
    const ui = useUIStore()
    ui.openAgentLibrary()
    ui.openAppSettings()

    ui.toggleModelManager()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.agentLibrary).toBeNull()
    expect(ui.frontmost).toBe('model')
  })

  it('names nothing frontmost while the Session shows', () => {
    expect(useUIStore().frontmost).toBeNull()
  })

  it('closes App Settings when a Library opens', () => {
    const ui = useUIStore()
    ui.openAppSettings()

    ui.openModelManager()

    expect(ui.appSettingsOpen).toBe(false)
    expect(ui.showModelManager).toBe(true)
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
    expect(ui.showModelManager).toBe(false)
  })
})

describe('The theme panel', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('opens beside whatever is shown, leaving Libraries open', () => {
    const ui = useUIStore()
    ui.openModelManager()

    ui.openThemePanel()

    expect(ui.themePanelOpen).toBe(true)
    expect(ui.showModelManager).toBe(true)
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
