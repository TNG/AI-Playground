import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useOemBranding } from '@/assets/js/store/oemBranding'

describe('presetLabel', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('shows Assistant under its own name', () => {
    expect(useOemBranding().presetLabel('Assistant')).toBe('Assistant')
  })

  it('leaves other presets their own name', () => {
    expect(useOemBranding().presetLabel('Game Agent')).toBe('Game Agent')
  })

  it('co-brands on Acer without touching the rename', () => {
    const branding = useOemBranding()
    branding.vendor = 'acer'
    expect(branding.presetLabel('Quick Coder')).toBe('Acer Quick Coder')
    expect(branding.presetLabel('Assistant')).toBe('Assistant')
  })
})
