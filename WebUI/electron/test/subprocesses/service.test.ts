import { describe, it, expect, vi, beforeEach } from 'vitest'
import path from 'node:path'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
  },
  BrowserWindow: vi.fn(),
  net: { fetch: vi.fn() },
}))

vi.mock('../../main.ts', () => ({}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

import { DeviceService } from '../../subprocesses/service'

describe('DeviceService', () => {
  let deviceService: DeviceService

  beforeEach(() => {
    vi.clearAllMocks()

    deviceService = new DeviceService()

    vi.spyOn(deviceService, 'run').mockImplementation(async () => {
      return JSON.stringify({
        device_list: [
          {
            device_id: 0,
            device_name: 'Intel(R) UHD Graphics',
            device_type: 'GPU',
            pci_bdf_address: '0000:00:02.0',
            pci_device_id: '0x9a60',
            uuid: '00000000-0000-0200-0000-00019a608086',
            vendor_name: 'Intel(R) Corporation',
          },
          {
            device_id: 1,
            device_name: 'Intel(R) Arc(TM) B580 Graphics',
            device_type: 'GPU',
            pci_bdf_address: '0000:03:00.0',
            pci_device_id: '0xe20b',
            uuid: '00000000-0000-0003-0000-0000e20b8086',
            vendor_name: 'Intel(R) Corporation',
          },
          {
            device_id: 2,
            device_name: 'Intel(R) Arc(TM) A770 Graphics',
            device_type: 'GPU',
            pci_bdf_address: '0000:03:00.0',
            pci_device_id: '0x56a0',
            uuid: '00000000-0000-0003-0000-000856a08086',
            vendor_name: 'Intel(R) Corporation',
          },
        ],
      })
    })
  })

  describe('getExePath', () => {
    it('should return the correct path to xpu-smi.exe', () => {
      const exePath = deviceService.getExePath()
      expect(exePath).toContain(path.join('device-service', 'xpu-smi.exe'))
    })
  })

  describe('getDevices', () => {
    it('should parse xpu-smi output and return sorted devices', async () => {
      const devices = await deviceService.getDevices()

      expect(devices).toHaveLength(3)
      expect(devices[0].name).toBe('Intel(R) Arc(TM) B580 Graphics')
      expect(devices[0].arch).toBe('bmg')
      expect(devices[1].name).toBe('Intel(R) Arc(TM) A770 Graphics')
      expect(devices[1].arch).toBe('acm')
      expect(devices[2].name).toBe('Intel(R) UHD Graphics')
    })

    it('should sort devices by architecture priority (highest first)', async () => {
      const devices = await deviceService.getDevices()

      const priorities = devices.map((d) => d.arch)
      expect(priorities).toEqual(['bmg', 'acm', 'unknown'])
    })

    it('should extract device IDs from UUIDs', async () => {
      const devices = await deviceService.getDevices()

      expect(devices[0].id).toBe(1)
      expect(devices[1].id).toBe(2)
      expect(devices[2].id).toBe(0)
    })
  })
})
