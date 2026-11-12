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
