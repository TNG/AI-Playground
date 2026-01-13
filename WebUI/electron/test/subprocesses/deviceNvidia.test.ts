import { describe, it, expect, vi } from 'vitest'

// Mock electron module to avoid import errors in tests
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/path'),
    isPackaged: false,
  },
}))

import { isNvidiaDevice } from '../../subprocesses/deviceNvidia.ts'

describe('deviceNvidia', () => {
  describe('isNvidiaDevice', () => {
    it('should detect NVIDIA GPUs by vendor name', () => {
      expect(isNvidiaDevice('NVIDIA GeForce RTX 4090')).toBe(true)
      expect(isNvidiaDevice('NVIDIA Corporation')).toBe(true)
    })

    it('should detect GeForce GPUs', () => {
      expect(isNvidiaDevice('GeForce RTX 4090')).toBe(true)
      expect(isNvidiaDevice('GeForce GTX 1080 Ti')).toBe(true)
      expect(isNvidiaDevice('NVIDIA GeForce RTX 3080')).toBe(true)
    })

    it('should detect RTX series GPUs', () => {
      expect(isNvidiaDevice('RTX 4090')).toBe(true)
      expect(isNvidiaDevice('RTX 3090 Ti')).toBe(true)
      expect(isNvidiaDevice('RTX 2080 Super')).toBe(true)
    })

    it('should detect GTX series GPUs', () => {
      expect(isNvidiaDevice('GTX 1080 Ti')).toBe(true)
      expect(isNvidiaDevice('GTX 1660 Super')).toBe(true)
      expect(isNvidiaDevice('GTX 980')).toBe(true)
    })

    it('should detect Quadro professional GPUs', () => {
      expect(isNvidiaDevice('NVIDIA Quadro RTX 8000')).toBe(true)
      expect(isNvidiaDevice('Quadro P5000')).toBe(true)
      expect(isNvidiaDevice('Quadro K6000')).toBe(true)
    })

    it('should detect Tesla datacenter GPUs', () => {
      expect(isNvidiaDevice('NVIDIA Tesla V100')).toBe(true)
      expect(isNvidiaDevice('Tesla K80')).toBe(true)
      expect(isNvidiaDevice('Tesla P100')).toBe(true)
    })

    it('should not detect non-NVIDIA GPUs', () => {
      expect(isNvidiaDevice('AMD Radeon RX 7900 XTX')).toBe(false)
      expect(isNvidiaDevice('Intel Arc A770')).toBe(false)
      expect(isNvidiaDevice('Intel UHD Graphics 770')).toBe(false)
      expect(isNvidiaDevice('CPU')).toBe(false)
    })

    it('should be case insensitive', () => {
      expect(isNvidiaDevice('nvidia geforce rtx 4090')).toBe(true)
      expect(isNvidiaDevice('NVIDIA GEFORCE RTX 4090')).toBe(true)
      expect(isNvidiaDevice('NvIdIa GeForce RTX 4090')).toBe(true)
      expect(isNvidiaDevice('rtx 4090')).toBe(true)
      expect(isNvidiaDevice('RTX 4090')).toBe(true)
    })
  })
})
