import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useOemBranding } from '@/assets/js/store/oemBranding'

describe('presetLabel', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows the Agent preset as Agent Maker', () => {
    expect(useOemBranding().presetLabel('Agent')).toBe('Agent Maker')
  })

  it('leaves other presets their own name', () => {
    expect(useOemBranding().presetLabel('Game Agent')).toBe('Game Agent')
  })

  it('co-brands on Acer without touching the rename', () => {
    const branding = useOemBranding()
    branding.vendor = 'acer'
    expect(branding.presetLabel('Quick Coder')).toBe('Acer Quick Coder')
    expect(branding.presetLabel('Agent')).toBe('Agent Maker')
  })
})
