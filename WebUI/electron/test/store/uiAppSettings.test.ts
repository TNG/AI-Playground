import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUIStore } from '@/assets/js/store/ui'

/** Stands in for unsaved theme colours: every leave waits for a confirm or cancel. */
function holdUnsavedChanges(ui: ReturnType<typeof useUIStore>) {
  let pending: (() => void) | null = null
  ui.setAppSettingsLeaveGuard((leave) => (pending = leave))
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

    expect(ui.appSettings).toEqual({})
    expect(ui.agentLibrary).toEqual({ agentId: 't1' })
    expect(ui.frontmost).toBe('settings')

    ui.closeAppSettings()

    expect(ui.appSettings).toBeNull()
    expect(ui.agentLibrary).toEqual({ agentId: 't1' })
    expect(ui.frontmost).toBe('agent')
  })

  it('reveals the Library under App Settings, as it was, when its button is clicked', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1', sessionRef: 's1' })
    ui.openAppSettings()

    ui.toggleAgentLibrary()

    expect(ui.appSettings).toBeNull()
    expect(ui.agentLibrary).toEqual({ agentId: 't1', sessionRef: 's1' })
  })

  it('switches from App Settings over one Library to the other Library', () => {
    const ui = useUIStore()
    ui.openAgentLibrary()
    ui.openAppSettings()

    ui.toggleModelManager()

    expect(ui.appSettings).toBeNull()
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

    expect(ui.appSettings).toBeNull()
    expect(ui.showModelManager).toBe(true)
  })

  it('closes App Settings when the Agent Library button is clicked', () => {
    const ui = useUIStore()
    ui.openAppSettings()

    ui.toggleAgentLibrary()

    expect(ui.appSettings).toBeNull()
    expect(ui.agentLibrary).toEqual({})
  })

  it('opens App Settings at the requested section', () => {
    const ui = useUIStore()

    ui.openAppSettings('theme')

    expect(ui.appSettings).toEqual({ section: { name: 'theme' } })
  })

  it('returns to the Session when App Settings closes', () => {
    const ui = useUIStore()
    ui.openAppSettings()

    ui.closeAppSettings()

    expect(ui.appSettings).toBeNull()
    expect(ui.agentLibrary).toBeNull()
    expect(ui.showModelManager).toBe(false)
  })

  it('asks before a Library replaces App Settings holding unsaved changes', () => {
    const ui = useUIStore()
    ui.openAppSettings()
    const unsaved = holdUnsavedChanges(ui)

    ui.openAgentLibrary({ agentId: 't1' })

    expect(unsaved.asking).toBe(true)
    expect(ui.appSettings).not.toBeNull()
    expect(ui.agentLibrary).toBeNull()

    unsaved.confirm()

    expect(ui.appSettings).toBeNull()
    expect(ui.agentLibrary).toEqual({ agentId: 't1' })
  })

  it('keeps App Settings open, with no Library, when leaving is cancelled', () => {
    const ui = useUIStore()
    ui.openAppSettings()
    const unsaved = holdUnsavedChanges(ui)

    ui.toggleModelManager()
    unsaved.cancel()
    ui.closeAppSettings()
    unsaved.cancel()

    expect(ui.appSettings).not.toBeNull()
    expect(ui.showModelManager).toBe(false)
  })

  it('opens a Library without asking when App Settings is closed', () => {
    const ui = useUIStore()
    const unsaved = holdUnsavedChanges(ui)

    ui.openModelManager()

    expect(unsaved.asking).toBe(false)
    expect(ui.showModelManager).toBe(true)
  })
})
