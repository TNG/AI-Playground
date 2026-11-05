import { describe, expect, it } from 'vitest'
import { presetGate } from '@/lib/presetGate'
import type { Preset } from '@/assets/js/store/presets'

const usable = { phisonUsable: true, homeAgentEnabled: true, homeAgentAvailable: true }

const chat = (name: string, extra: Record<string, unknown> = {}) =>
  ({ type: 'chat', name, category: 'chat', ...extra }) as unknown as Preset
const comfy = (name: string) => ({ type: 'comfy', name, category: 'create-images' }) as Preset

describe('preset gate', () => {
  it('lets ordinary presets through', () => {
    expect(presetGate(chat('Assistant'), usable)).toEqual({ enabled: true })
    expect(presetGate(comfy('Fast'), { ...usable, phisonUsable: false })).toEqual({
      enabled: true,
    })
  })

  it('greys out an aiDAPTIV preset until its build is usable', () => {
    const phison = chat('aiDAPTIV', { requiresPhison: true })
    expect(presetGate(phison, usable)).toEqual({ enabled: true })
    expect(presetGate(phison, { ...usable, phisonUsable: false })).toEqual({
      enabled: false,
      reason: 'Install and activate the aiDAPTIV™ build to use this preset.',
    })
  })

  it('greys out Home Agent chat until the Home Agent is on and running', () => {
    const homeAgent = chat('Home Agent')
    expect(presetGate(homeAgent, usable)).toEqual({ enabled: true })
    expect(presetGate(homeAgent, { ...usable, homeAgentEnabled: false })).toEqual({
      enabled: false,
      reason: 'Enable the Home Agent in settings to use this preset.',
    })
    expect(presetGate(homeAgent, { ...usable, homeAgentAvailable: false })).toEqual({
      enabled: false,
      reason: 'The Home Agent backend is not installed or running yet.',
    })
  })
})
