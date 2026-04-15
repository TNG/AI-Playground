import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../../subprocesses/uvBasedBackends/uv.ts', () => ({
  buildResources: '/mock/build/resources',
  uvPath: '/mock/uv',
}))

import {
  parsePowerShellGpuOutput,
  parseNvidiaSmiListOutput,
  enrichWithPowerShellIds,
  type GpuHardwareDevice,
} from '../../subprocesses/hardwareDiscovery'

describe('parsePowerShellGpuOutput', () => {
  it('should extract Intel GPU with PCI device ID from PNPDeviceID', () => {
    const output = JSON.stringify([
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toEqual([
      {
        device: 'INTEL_GPU_PNP',
        name: 'Intel(R) Graphics',
        gpuDeviceId: '0xFD80',
      },
    ])
  })

  it('should filter out non-Intel GPUs', () => {
    const output = JSON.stringify([
      {
        Name: 'NVIDIA GeForce RTX 4090',
        PNPDeviceID: 'PCI\\VEN_10DE&DEV_2684&SUBSYS_00001234&REV_A1',
      },
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toHaveLength(1)
    expect(result[0].gpuDeviceId).toBe('0xFD80')
  })

  it('should handle multiple Intel GPUs', () => {
    const output = JSON.stringify([
      {
        Name: 'Intel(R) Arc(TM) B580 Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_E20B&SUBSYS_00001234&REV_00',
      },
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toHaveLength(2)
    expect(result[0].gpuDeviceId).toBe('0xE20B')
    expect(result[1].gpuDeviceId).toBe('0xFD80')
  })

  it('should handle a single object (not array) when only one GPU exists', () => {
    const output = JSON.stringify({
      Name: 'Intel(R) Graphics',
      PNPDeviceID: 'PCI\\VEN_8086&DEV_FD81&SUBSYS_22128086&REV_01',
    })

    const result = parsePowerShellGpuOutput(output)

    expect(result).toEqual([
      {
        device: 'INTEL_GPU_PNP',
        name: 'Intel(R) Graphics',
        gpuDeviceId: '0xFD81',
      },
    ])
  })

  it('should skip entries with null PNPDeviceID', () => {
    const output = JSON.stringify([
      {
        Name: 'Microsoft Basic Display Adapter',
        PNPDeviceID: null,
      },
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toHaveLength(1)
    expect(result[0].gpuDeviceId).toBe('0xFD80')
  })

  it('should skip entries with non-PCI PNPDeviceID', () => {
    const output = JSON.stringify([
      {
        Name: 'Microsoft Remote Display Adapter',
        PNPDeviceID: 'ROOT\\YOURDEVICE\\0000',
      },
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_FD80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toHaveLength(1)
    expect(result[0].gpuDeviceId).toBe('0xFD80')
  })

  it('should return empty array when no Intel GPUs present', () => {
    const output = JSON.stringify([
      {
        Name: 'NVIDIA GeForce RTX 4090',
        PNPDeviceID: 'PCI\\VEN_10DE&DEV_2684&SUBSYS_00001234&REV_A1',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result).toEqual([])
  })

  it('should uppercase the device ID hex digits', () => {
    const output = JSON.stringify([
      {
        Name: 'Intel(R) Graphics',
        PNPDeviceID: 'PCI\\VEN_8086&DEV_fd80&SUBSYS_22128086&REV_01',
      },
    ])

    const result = parsePowerShellGpuOutput(output)

    expect(result[0].gpuDeviceId).toBe('0xFD80')
  })
})

describe('parseNvidiaSmiListOutput', () => {
  it('should parse a single GPU line with UUID', () => {
    const output = 'GPU 0: NVIDIA GeForce RTX 4090 (UUID: GPU-abc-123-def)\n'
    const result = parseNvidiaSmiListOutput(output)

    expect(result).toEqual([{ index: 0, name: 'NVIDIA GeForce RTX 4090', uuid: 'GPU-abc-123-def' }])
  })

  it('should parse multiple GPU lines', () => {
    const output = [
      'GPU 0: NVIDIA GeForce RTX 4090 (UUID: GPU-aaa)',
      'GPU 1: NVIDIA GeForce RTX 3080 (UUID: GPU-bbb)',
    ].join('\n')

    const result = parseNvidiaSmiListOutput(output)

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ index: 0, name: 'NVIDIA GeForce RTX 4090', uuid: 'GPU-aaa' })
    expect(result[1]).toEqual({ index: 1, name: 'NVIDIA GeForce RTX 3080', uuid: 'GPU-bbb' })
  })

  it('should handle lines without UUID', () => {
    const output = 'GPU 0: NVIDIA GeForce RTX 4090\n'
    const result = parseNvidiaSmiListOutput(output)

    expect(result).toEqual([{ index: 0, name: 'NVIDIA GeForce RTX 4090', uuid: undefined }])
  })

  it('should skip non-matching lines', () => {
    const output = [
      'some random preamble',
      'GPU 0: NVIDIA GeForce RTX 4090 (UUID: GPU-aaa)',
      '',
      'other garbage',
    ].join('\n')

    const result = parseNvidiaSmiListOutput(output)

    expect(result).toHaveLength(1)
    expect(result[0].name).toBe('NVIDIA GeForce RTX 4090')
  })

  it('should return empty array for empty output', () => {
    expect(parseNvidiaSmiListOutput('')).toEqual([])
  })

  it('should handle high GPU indices', () => {
    const output = 'GPU 7: NVIDIA A100 (UUID: GPU-zzz)\n'
    const result = parseNvidiaSmiListOutput(output)

    expect(result).toEqual([{ index: 7, name: 'NVIDIA A100', uuid: 'GPU-zzz' }])
  })
})

describe('enrichWithPowerShellIds', () => {
  it('should fill in null gpuDeviceId from matching PowerShell device by name', () => {
    const xpuDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU:0', name: 'Intel(R) Graphics', gpuDeviceId: null },
    ]
    const psDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU_PNP', name: 'Intel(R) Graphics', gpuDeviceId: '0xFD80' },
    ]

    const result = enrichWithPowerShellIds(xpuDevices, psDevices)

    expect(result).toEqual([
      { device: 'INTEL_GPU:0', name: 'Intel(R) Graphics', gpuDeviceId: '0xFD80' },
    ])
  })

  it('should not overwrite existing gpuDeviceId', () => {
    const xpuDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU:0', name: 'Intel(R) Graphics', gpuDeviceId: '0xE202' },
    ]
    const psDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU_PNP', name: 'Intel(R) Graphics', gpuDeviceId: '0xFD80' },
    ]

    const result = enrichWithPowerShellIds(xpuDevices, psDevices)

    expect(result[0].gpuDeviceId).toBe('0xE202')
  })

  it('should match names case-insensitively', () => {
    const xpuDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU:0', name: 'intel(r) graphics', gpuDeviceId: null },
    ]
    const psDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU_PNP', name: 'Intel(R) Graphics', gpuDeviceId: '0xFD80' },
    ]

    const result = enrichWithPowerShellIds(xpuDevices, psDevices)

    expect(result[0].gpuDeviceId).toBe('0xFD80')
  })

  it('should leave gpuDeviceId as null when no PowerShell match exists', () => {
    const xpuDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU:0', name: 'Unique GPU', gpuDeviceId: null },
    ]
    const psDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU_PNP', name: 'Different GPU', gpuDeviceId: '0xFD80' },
    ]

    const result = enrichWithPowerShellIds(xpuDevices, psDevices)

    expect(result[0].gpuDeviceId).toBeNull()
  })

  it('should handle multiple devices with mixed null and non-null ids', () => {
    const xpuDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU:0', name: 'GPU Alpha', gpuDeviceId: '0xE202' },
      { device: 'INTEL_GPU:1', name: 'GPU Beta', gpuDeviceId: null },
    ]
    const psDevices: GpuHardwareDevice[] = [
      { device: 'INTEL_GPU_PNP', name: 'GPU Beta', gpuDeviceId: '0xFD81' },
    ]

    const result = enrichWithPowerShellIds(xpuDevices, psDevices)

    expect(result[0].gpuDeviceId).toBe('0xE202')
    expect(result[1].gpuDeviceId).toBe('0xFD81')
  })

  it('should return empty array when given empty input', () => {
    expect(enrichWithPowerShellIds([], [])).toEqual([])
  })
})
