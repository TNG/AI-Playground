import { describe, expect, it } from 'vitest'
import { templateMediaToolSettings } from '@/lib/mediaToolSettings'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'

function editable(initial: AgentSessionSettings) {
  let template = initial
  const settings = templateMediaToolSettings(
    () => template,
    (change) => {
      template = { ...template, ...change }
    },
  )
  return { settings, current: () => template }
}

describe('media tool settings of a Settings Template', () => {
  it('reads the defaults while the template says nothing', () => {
    const { settings } = editable({})

    expect(settings.delegationEnabled()).toBe(true)
    expect(settings.isToolEnabled('comfyUI')).toBe(true)
    expect(settings.isToolEnabled('captureScreenshot')).toBe(false)
    expect(settings.isWorkflowEnabled('Draft Image')).toBe(true)
    expect(settings.defaultWorkflow('comfyUI:image', ['Fast', 'Draft Image'])).toBe('Draft Image')
  })

  it('writes each change into the template, keeping the other entries', () => {
    const { settings, current } = editable({
      builtinToolEnablement: { comfyUI: false },
      model: 'Kept-9B',
    })

    settings.setDelegationEnabled(false)
    settings.setToolEnabled('transcribeAudio', false)
    settings.setWorkflowEnabled('Draft Image', false)
    settings.setDefaultWorkflow('comfyUI:image', 'Fast')

    expect(current()).toEqual({
      model: 'Kept-9B',
      toolDelegationEnabled: false,
      builtinToolEnablement: { comfyUI: false, transcribeAudio: false },
      builtinToolPresetEnablement: { 'Draft Image': false },
      builtinToolDefaultPresets: { 'comfyUI:image': 'Fast' },
    })
    expect(settings.isToolEnabled('comfyUI')).toBe(false)
    expect(settings.defaultWorkflow('comfyUI:image', ['Fast', 'Draft Image'])).toBe('Fast')
  })
})
