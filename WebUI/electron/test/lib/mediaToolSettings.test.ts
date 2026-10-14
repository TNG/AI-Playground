import { describe, expect, it } from 'vitest'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import { draftMediaToolSettings } from '@/lib/mediaToolSettings'

function draftOf(initial: AgentSessionSettings) {
  let template: AgentSessionSettings = initial
  const settings = draftMediaToolSettings({
    read: () => template,
    update: (change) => {
      template = { ...template, ...change }
    },
  })
  return { settings, template: () => template }
}

describe('draftMediaToolSettings', () => {
  it('reads the defaults a session gets from a template that stores nothing', () => {
    const { settings } = draftOf({})
    expect(settings.delegationEnabled()).toBe(true)
    expect(settings.isToolEnabled('comfyUI')).toBe(true)
    expect(settings.isToolEnabled('captureScreenshot')).toBe(false)
    expect(settings.isWorkflowEnabled('Draft Image')).toBe(true)
    expect(settings.defaultWorkflow('comfyUI:image', ['Fast Image', 'Draft Image'])).toBe(
      'Draft Image',
    )
  })

  it('writes each change into its Settings Template field, keeping the other entries', () => {
    const { settings, template } = draftOf({
      model: 'Qwen3.5-9B',
      builtinToolEnablement: { transcribeAudio: false },
      builtinToolPresetEnablement: { 'Draft Image': false },
      builtinToolDefaultPresets: { 'comfyUI:video': 'Wan' },
    })

    settings.setDelegationEnabled(false)
    settings.setToolEnabled('comfyUiImageEdit', false)
    settings.setWorkflowEnabled('Edit By Prompt', false)
    settings.setDefaultWorkflow('comfyUI:image', 'Fast Image')

    expect(template()).toEqual({
      model: 'Qwen3.5-9B',
      toolDelegationEnabled: false,
      builtinToolEnablement: { transcribeAudio: false, comfyUiImageEdit: false },
      builtinToolPresetEnablement: { 'Draft Image': false, 'Edit By Prompt': false },
      builtinToolDefaultPresets: { 'comfyUI:video': 'Wan', 'comfyUI:image': 'Fast Image' },
    })
  })

  it('reads back what the template stores', () => {
    const { settings } = draftOf({
      toolDelegationEnabled: false,
      builtinToolEnablement: { comfyUI: false, captureScreenshot: true },
      builtinToolPresetEnablement: { 'Draft Image': false },
      builtinToolDefaultPresets: { 'comfyUI:image': 'Fast Image' },
    })
    expect(settings.delegationEnabled()).toBe(false)
    expect(settings.isToolEnabled('comfyUI')).toBe(false)
    expect(settings.isToolEnabled('captureScreenshot')).toBe(true)
    expect(settings.isWorkflowEnabled('Draft Image')).toBe(false)
    expect(settings.defaultWorkflow('comfyUI:image', ['Draft Image', 'Fast Image'])).toBe(
      'Fast Image',
    )
  })

  it('falls back from a stored default that is no longer enabled', () => {
    const { settings } = draftOf({ builtinToolDefaultPresets: { 'comfyUI:image': 'Fast Image' } })
    expect(settings.defaultWorkflow('comfyUI:image', ['Draft Image'])).toBe('Draft Image')
    expect(settings.defaultWorkflow('comfyUI:video', ['Wan', 'LTX'])).toBe('Wan')
    expect(settings.defaultWorkflow('comfyUI:video', [])).toBeNull()
  })
})
