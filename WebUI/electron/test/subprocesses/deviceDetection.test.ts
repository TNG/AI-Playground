import { describe, it, expect } from 'vitest'
import {
  levelZeroDeviceSelectorEnv,
  cudaVisibleDevicesEnv,
  vulkanDeviceSelectorEnv,
  openVinoDeviceSelectorEnv,
} from '../../subprocesses/deviceDetection'

describe('deviceDetection env helpers', () => {
  describe('levelZeroDeviceSelectorEnv', () => {
    it('defaults to wildcard when no id is provided', () => {
      expect(levelZeroDeviceSelectorEnv()).toEqual({ ONEAPI_DEVICE_SELECTOR: 'level_zero:*' })
    })

    it('defaults to wildcard when id is undefined', () => {
      expect(levelZeroDeviceSelectorEnv(undefined)).toEqual({
        ONEAPI_DEVICE_SELECTOR: 'level_zero:*',
      })
    })

    it('uses the provided device id', () => {
      expect(levelZeroDeviceSelectorEnv('0')).toEqual({ ONEAPI_DEVICE_SELECTOR: 'level_zero:0' })
    })

    it('passes through a wildcard id unchanged', () => {
      expect(levelZeroDeviceSelectorEnv('*')).toEqual({ ONEAPI_DEVICE_SELECTOR: 'level_zero:*' })
    })
  })

  describe('cudaVisibleDevicesEnv', () => {
    it('returns empty object when id is undefined (all GPUs visible)', () => {
      expect(cudaVisibleDevicesEnv()).toEqual({})
      expect(cudaVisibleDevicesEnv(undefined)).toEqual({})
    })

    it('returns empty object when id is wildcard (all GPUs visible)', () => {
      expect(cudaVisibleDevicesEnv('*')).toEqual({})
    })

    it('restricts to specific device when a numeric id is given', () => {
      expect(cudaVisibleDevicesEnv('0')).toEqual({ CUDA_VISIBLE_DEVICES: '0' })
      expect(cudaVisibleDevicesEnv('1')).toEqual({ CUDA_VISIBLE_DEVICES: '1' })
    })

    it('passes through non-numeric ids verbatim', () => {
      expect(cudaVisibleDevicesEnv('GPU-abc-123')).toEqual({
        CUDA_VISIBLE_DEVICES: 'GPU-abc-123',
      })
    })
  })

  describe('vulkanDeviceSelectorEnv', () => {
    it('defaults to device 0 when no id is provided', () => {
      expect(vulkanDeviceSelectorEnv()).toEqual({ GGML_VK_VISIBLE_DEVICES: '0' })
    })

    it('uses the provided device id', () => {
      expect(vulkanDeviceSelectorEnv('1')).toEqual({ GGML_VK_VISIBLE_DEVICES: '1' })
    })
  })

  describe('openVinoDeviceSelectorEnv', () => {
    it('defaults to AUTO when no id is provided', () => {
      expect(openVinoDeviceSelectorEnv()).toEqual({ OPENVINO_DEVICE: 'AUTO' })
    })

    it('uses the provided device id', () => {
      expect(openVinoDeviceSelectorEnv('GPU.0')).toEqual({ OPENVINO_DEVICE: 'GPU.0' })
    })
  })
})
