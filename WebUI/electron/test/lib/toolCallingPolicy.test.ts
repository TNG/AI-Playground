import { describe, expect, it } from 'vitest'
import { allowsToolCalling } from '@/lib/toolCallingPolicy'

describe('allowsToolCalling', () => {
  it('allows tools in Studio and NVIDIA mode outside Demo Mode', () => {
    expect(allowsToolCalling({ isDemoModeEnabled: false, productMode: 'studio' })).toBe(true)
    expect(allowsToolCalling({ isDemoModeEnabled: false, productMode: 'nvidia' })).toBe(true)
    expect(allowsToolCalling({ isDemoModeEnabled: false })).toBe(true)
  })

  it('refuses tools in Essentials', () => {
    expect(allowsToolCalling({ isDemoModeEnabled: false, productMode: 'essentials' })).toBe(false)
  })

  it('refuses tools in Demo Mode whatever the product mode', () => {
    expect(allowsToolCalling({ isDemoModeEnabled: true, productMode: 'studio' })).toBe(false)
    expect(allowsToolCalling({ isDemoModeEnabled: true })).toBe(false)
  })
})
