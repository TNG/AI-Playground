/**
 * Shared utilities for device detection and management across different backends
 */

import { appLoggerInstance } from '../logging/logger.ts'
import { isIntelDevice } from './deviceArch.ts'
import { isNvidiaDevice } from './deviceNvidia.ts'

export type DeviceType = 'CUDA' | 'XPU' | 'CPU'
export type GpuVendor = 'nvidia' | 'intel' | 'vulkan' | 'unknown'

export interface DetectedDevice {
  id: string
  name: string
}

/**
 * Check if a device name suggests it's a dedicated GPU (vs integrated)
 */
export function isDedicatedGpu(deviceName: string): boolean {
  const lowerName = deviceName.toLowerCase()

  // Intel integrated GPU patterns
  const integratedPatterns = ['uhd graphics', 'iris xe graphics', 'iris plus', 'hd graphics']

  // If it's Intel and matches integrated patterns, it's not dedicated
  if (isIntelDevice(deviceName)) {
    return !integratedPatterns.some((pattern) => lowerName.includes(pattern))
  }

  // All NVIDIA GPUs are considered dedicated
  if (isNvidiaDevice(deviceName)) {
    return true
  }

  // Other GPUs are typically dedicated
  return true
}

/**
 * Get device priority for sorting (lower number = higher priority)
 * Priority order:
 * 1. Intel dedicated GPU
 * 2. Intel integrated GPU
 * 3. NVIDIA GPU
 * 4. Other GPUs
 * 5. CPU
 */
export function getDevicePriority(device: { id: string; name: string }): number {
  const lowerName = device.name.toLowerCase()

  // CPU has lowest priority
  if (device.id === 'cpu' || lowerName.includes('cpu')) {
    return 100
  }

  // Intel GPUs have highest priority
  if (isIntelDevice(device.name)) {
    if (isDedicatedGpu(device.name)) {
      return 1 // Intel dedicated GPU - highest priority
    } else {
      return 2 // Intel integrated GPU - second priority
    }
  }

  // NVIDIA GPUs are third priority
  if (isNvidiaDevice(device.name)) {
    return 3
  }

  // Other GPUs are fourth priority
  return 4
}

/**
 * Sort devices by priority and return with first device selected by default
 */
export function prioritizeDevices(
  devices: Array<{ id: string; name: string }>,
  serviceName: string,
): Array<{ id: string; name: string; selected: boolean }> {
  if (devices.length === 0) {
    return []
  }

  // Sort by priority
  const sortedDevices = [...devices].sort((a, b) => {
    const priorityA = getDevicePriority(a)
    const priorityB = getDevicePriority(b)
    return priorityA - priorityB
  })

  // Log the sorted order
  appLoggerInstance.info(
    `Device priority order: ${sortedDevices.map((d, i) => `${i + 1}. ${d.name} (priority: ${getDevicePriority(d)})`).join(', ')}`,
    serviceName,
  )

  // Mark first device as selected
  return sortedDevices.map((d, index) => ({
    ...d,
    selected: index === 0,
  }))
}

/**
 * Detect GPU vendor from device name
 */
export function detectGpuVendor(deviceName: string): GpuVendor {
  if (isNvidiaDevice(deviceName)) {
    return 'nvidia'
  }

  if (isIntelDevice(deviceName)) {
    return 'intel'
  }

  // Everything else uses Vulkan backend
  return 'vulkan'
}

/**
 * Python script to detect PyTorch devices (CUDA, XPU, CPU)
 */
export const TORCH_DEVICE_DETECTION_SCRIPT = `
import torch
import sys

# Try CUDA first (NVIDIA GPUs)
try:
    if torch.cuda.is_available():
        device_count = torch.cuda.device_count()
        print("DEVICE_TYPE:CUDA")
        for i in range(device_count):
            try:
                device_name = torch.cuda.get_device_name(i)
                print(f"{i}|{device_name}")
            except Exception as e:
                print(f"{i}|Unknown CUDA Device")
        sys.exit(0)
except Exception as e:
    print(f"CUDA check error: {str(e)}", file=sys.stderr)


# Try XPU next (Intel Arc GPUs)
try:
    if hasattr(torch, 'xpu') and torch.xpu.is_available():
        device_count = torch.xpu.device_count()
        print("DEVICE_TYPE:XPU")
        for i in range(device_count):
            try:
                device_name = torch.xpu.get_device_name(i)
                print(f"{i}|{device_name}")
            except Exception as e:
                print(f"{i}|Unknown XPU Device")
        sys.exit(0)
except Exception as e:
    print(f"XPU check error: {str(e)}", file=sys.stderr)

# Fallback to CPU
print("DEVICE_TYPE:CPU")
print("0|CPU")
`

/**
 * Parse device detection output from Python script
 */
export function parseDeviceDetectionOutput(
  output: string,
  serviceName: string,
): { deviceType: DeviceType; devices: DetectedDevice[] } {
  let deviceType: DeviceType = 'XPU' // Default for backward compatibility
  const devices: DetectedDevice[] = []

  const lines = output
    .split('\n')
    .map((l) => l.trim())
    .filter((line) => line !== '')

  for (const line of lines) {
    if (line.startsWith('DEVICE_TYPE:')) {
      deviceType = line.split(':')[1] as DeviceType
      appLoggerInstance.info(`Detected device type: ${deviceType}`, serviceName)
      continue
    }

    const parts = line.split('|', 2)
    if (parts.length === 2) {
      const id = parts[0]
      const name = parts[1]
      devices.push({ id, name })
    }
  }

  return { deviceType, devices }
}
