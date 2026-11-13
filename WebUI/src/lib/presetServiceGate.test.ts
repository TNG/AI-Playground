import { describe, expect, it } from 'vitest'
import { requiredServiceGate } from './presetServiceGate'

const name = (s: string) => (s === 'sdcpp-backend' ? 'sd.cpp with Phison Pascari aiDAPTIV' : s)

describe('requiredServiceGate', () => {
  it('lets a preset without a required service through', () => {
    expect(requiredServiceGate(undefined, [], name)).toEqual({ enabled: true })
  })

  it('greys the preset out while the service is not installed, and says where to install it', () => {
    const notInstalled = [{ serviceName: 'sdcpp-backend', status: 'notInstalled' }]
    for (const services of [[], notInstalled]) {
      expect(requiredServiceGate('sdcpp-backend', services, name)).toEqual({
        enabled: false,
        reason: 'Install sd.cpp with Phison Pascari aiDAPTIV on the Setup page to use this preset.',
      })
    }
  })

  it('enables the preset once the service is installed, running or not', () => {
    for (const status of ['running', 'stopped']) {
      const services = [{ serviceName: 'sdcpp-backend', status }]
      expect(requiredServiceGate('sdcpp-backend', services, name).enabled).toBe(true)
    }
  })
})
