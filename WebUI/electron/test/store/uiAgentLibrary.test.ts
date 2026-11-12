import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useUIStore } from '@/assets/js/store/ui'

describe('Agent Library view', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('forgets the request to show the Trial Run once it has been shown', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1', sessionRef: 's1', showTrialRun: true })

    ui.trialRunShown()

    expect(ui.agentLibrary).toEqual({ agentId: 't1', sessionRef: 's1' })
  })

  it('leaves a closed Library closed when the Trial Run is reported shown', () => {
    const ui = useUIStore()
    ui.trialRunShown()
    expect(ui.agentLibrary).toBeNull()
  })

  it('drops the request to show the Trial Run when another Agent is selected', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1', showTrialRun: true })

    ui.selectLibraryAgent('t2')

    expect(ui.agentLibrary).toEqual({ agentId: 't2' })
  })
})

describe('One Library at a time', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows only the Model Library when it is opened over the Agent Library', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1' })

    ui.openModelManager()

    expect(ui.showModelManager).toBe(true)
    expect(ui.agentLibrary).toBeNull()
  })

  it('shows only the Agent Library when it is opened over the Model Library', () => {
    const ui = useUIStore()
    ui.openModelManager()

    ui.openAgentLibrary({ sessionRef: 's1' })

    expect(ui.showModelManager).toBe(false)
    expect(ui.agentLibrary).toEqual({ sessionRef: 's1' })
  })

  it('returns to the Session when the Library opened last is closed', () => {
    const ui = useUIStore()
    ui.openAgentLibrary()
    ui.openModelManager()

    ui.closeModelManager()

    expect(ui.showModelManager).toBe(false)
    expect(ui.agentLibrary).toBeNull()
  })

  it('leaves the Model Library open when the Agent Library, which is not open, is closed', () => {
    const ui = useUIStore()
    ui.openModelManager()

    ui.closeAgentLibrary()

    expect(ui.showModelManager).toBe(true)
  })

  it('leaves the Agent Library open when the Model Library, which is not open, is closed', () => {
    const ui = useUIStore()
    ui.openAgentLibrary({ agentId: 't1' })

    ui.closeModelManager()

    expect(ui.agentLibrary).toEqual({ agentId: 't1' })
  })

  it('ignores Agent Library operations while the Model Library is open', () => {
    const ui = useUIStore()
    ui.openModelManager()

    ui.selectLibraryAgent('t1')
    ui.clearLibrarySessionFilter()
    ui.trialRunShown()

    expect(ui.showModelManager).toBe(true)
    expect(ui.agentLibrary).toBeNull()
  })
})
