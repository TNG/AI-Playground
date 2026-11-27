import { describe, expect, it } from 'vitest'
import { diffDeviceSnapshots } from '../../../src/lib/deviceListDiff'
import type { DeviceDebugEntry, DeviceDebugSnapshot } from '../../../src/types/deviceDebug'

function snapshot(
  devices: DeviceDebugEntry[],
  overrides: Partial<DeviceDebugSnapshot> = {},
): DeviceDebugSnapshot {
  return {
    capturedAt: '2026-01-01T00:00:00.000Z',
    platform: 'win32',
    hardware: [],
    backends: {
      'llamacpp-backend': { devices, source: 'test', reProbed: true },
    },
    persisted: {
      lastSelectedDevicePerBackend: {},
      lastSelectedDeviceUuidPerBackend: {},
      preferredDevice: null,
    },
    ...overrides,
  }
}

const gpu = (id: string, name: string, uuid?: string): DeviceDebugEntry => ({ id, name, uuid })

describe('diffDeviceSnapshots', () => {
  it('reports no change for an identical list', () => {
    const list = [gpu('0', 'Arc B580'), gpu('1', 'Arc B60')]
    const diff = diffDeviceSnapshots(snapshot(list), snapshot(list))
    expect(diff.backends['llamacpp-backend'].changed).toBe(false)
  })

  it('flags a reorder of the same devices', () => {
    const before = [gpu('0', 'Arc B580'), gpu('1', 'Arc B60')]
    const after = [gpu('0', 'Arc B60'), gpu('1', 'Arc B580')]
    const diff = diffDeviceSnapshots(snapshot(before), snapshot(after))
    expect(diff.backends['llamacpp-backend'].changed).toBe(true)
    expect(diff.backends['llamacpp-backend'].reordered).toHaveLength(2)
  })

  it('flags additions and removals', () => {
    const diff = diffDeviceSnapshots(
      snapshot([gpu('0', 'Arc B580')]),
      snapshot([gpu('0', 'Arc B580'), gpu('1', 'Arc B60')]),
    )
    expect(diff.backends['llamacpp-backend'].added).toEqual(['Arc B60'])
    expect(diff.backends['llamacpp-backend'].removed).toEqual([])
  })

  it('flags a persisted id that now points at a different device', () => {
    const before = snapshot([gpu('0', 'Arc B580'), gpu('1', 'Arc B60')], {
      persisted: {
        lastSelectedDevicePerBackend: { 'llamacpp-backend': '1' },
        lastSelectedDeviceUuidPerBackend: {},
        preferredDevice: null,
      },
    })
    const after = snapshot([gpu('0', 'Arc B60'), gpu('1', 'Arc B580')], {
      persisted: before.persisted,
    })
    const [drift] = diffDeviceSnapshots(before, after).selections
    expect(drift.kind).toBe('moved')
    expect(drift.beforeName).toBe('Arc B60')
    expect(drift.afterName).toBe('Arc B580')
  })

  it('treats a persisted uuid as the identity when its id shifts', () => {
    const before = snapshot([gpu('0', 'Arc B580', 'abc')], {
      persisted: {
        lastSelectedDevicePerBackend: { 'llamacpp-backend': '0' },
        lastSelectedDeviceUuidPerBackend: { 'llamacpp-backend': 'abc' },
        preferredDevice: null,
      },
    })
    const after = snapshot([gpu('1', 'Arc B580', 'abc')], { persisted: before.persisted })
    const [drift] = diffDeviceSnapshots(before, after).selections
    expect(drift.kind).toBe('same')
    expect(drift.afterId).toBe('1')
  })
})
