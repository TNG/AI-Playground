import { describe, expect, it } from 'vitest'
import { preferredDeviceKey, resolvePreferredDevice } from '@/lib/preferredDevice'

const arc: PreferredDevice = {
  name: 'Intel Arc B580',
  gpuDeviceId: '0x56a0',
  uuid: 'uuid-arc',
}
const a770: PreferredDevice = {
  name: 'Intel Arc A770',
  gpuDeviceId: '0x56a0',
  uuid: 'uuid-a770',
}
const twinA: PreferredDevice = {
  name: 'Intel Arc Pro B60',
  gpuDeviceId: '0x56a0',
  instanceId: 'GPU.0',
}
const twinB: PreferredDevice = { ...twinA, instanceId: 'GPU.1' }

function options(...devices: PreferredDevice[]) {
  return devices.map((value) => ({ key: preferredDeviceKey(value)!, value }))
}

describe('preferredDeviceKey', () => {
  it('prefers the stable identity, strongest first', () => {
    expect(preferredDeviceKey(arc)).toBe('gpu:uuid-arc')
    expect(preferredDeviceKey(twinA)).toBe('gpu:GPU.0')
    expect(preferredDeviceKey(twinB)).toBe('gpu:GPU.1')
    expect(preferredDeviceKey({ name: 'CPU', gpuDeviceId: '0x1234' })).toBe('gpu:0x1234')
    expect(preferredDeviceKey({ name: 'CPU', gpuDeviceId: null })).toBe('gpu:CPU')
  })

  it('has no key for no preference', () => {
    expect(preferredDeviceKey(null)).toBeNull()
  })
})

describe('resolvePreferredDevice', () => {
  it('keeps a stored preference while that GPU is still offered', () => {
    expect(resolvePreferredDevice(a770, options(arc, a770))).toEqual(a770)
  })

  it('falls back to the best offered GPU when the stored one is gone', () => {
    const removed: PreferredDevice = { ...a770, uuid: 'uuid-sold' }
    expect(resolvePreferredDevice(removed, options(arc, a770))).toEqual(arc)
  })

  it('falls back to the best offered GPU when nothing is stored', () => {
    expect(resolvePreferredDevice(null, options(arc, a770))).toEqual(arc)
  })

  it('selects nothing when the machine offers nothing', () => {
    expect(resolvePreferredDevice(arc, [])).toBeNull()
    expect(resolvePreferredDevice(null, [])).toBeNull()
  })
})
