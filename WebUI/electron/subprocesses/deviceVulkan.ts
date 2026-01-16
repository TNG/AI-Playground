/**
 * Vulkan-capable GPU detection utilities
 * Detects GPUs that should use Vulkan backend (Intel Arc, other non-NVIDIA GPUs)
 * Note: Intel devices are included as llama.cpp uses Vulkan backend for Intel Arc GPUs
 */

import { promisify } from 'util'
import { exec } from 'child_process'
import { appLoggerInstance } from '../logging/logger.ts'
import { isNvidiaDevice } from './deviceNvidia.ts'
import { isIntelDevice } from './deviceArch.ts'

const execAsync = promisify(exec)

export interface VulkanDevice {
  id: string
  name: string
}

/**
 * Detect Vulkan-capable GPUs across all platforms
 * Returns GPUs that use Vulkan backend (Intel Arc, non-NVIDIA GPUs)
 *
 * @param serviceName - The name of the service calling this function (for logging)
 * @returns Promise resolving to array of detected Vulkan devices
 */
export async function detectVulkanGpus(serviceName: string): Promise<VulkanDevice[]> {
  if (process.platform === 'win32') {
    return detectVulkanGpusWindows(serviceName)
  } else if (process.platform === 'linux') {
    return detectVulkanGpusLinux(serviceName)
  } else if (process.platform === 'darwin') {
    return detectVulkanGpusMac(serviceName)
  }

  appLoggerInstance.info(
    `Vulkan GPU detection not implemented for platform: ${process.platform}`,
    serviceName,
  )
  return []
}

/**
 * Detect Vulkan-capable GPUs on Windows using WMI
 */
async function detectVulkanGpusWindows(serviceName: string): Promise<VulkanDevice[]> {
  const devices: VulkanDevice[] = []

  try {
    // Query all video controllers
    const query =
      'wmic path win32_videocontroller get caption,pnpdeviceid,status,availability /format:csv'
    const { stdout } = await execAsync(query, {
      timeout: 10000,
      windowsHide: true,
    })

    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((line) => line !== '')

    // Skip header line
    if (lines.length <= 1) {
      appLoggerInstance.info('No video controllers found via WMI', serviceName)
      return devices
    }

    let deviceIndex = 0
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]
      const parts = line.split(',').map((s) => s.trim())

      if (parts.length < 4) continue

      // CSV format: Node,Availability,Caption,PNPDeviceID,Status
      const deviceName = parts[2] || ''
      const pnpDeviceId = parts[3] || ''
      const status = parts[4] || ''

      if (!deviceName || status.toLowerCase() !== 'ok') {
        continue
      }

      // Skip NVIDIA devices - they use CUDA backend
      // Intel devices are included as they use Vulkan backend for llama.cpp
      if (isNvidiaDevice(deviceName)) {
        appLoggerInstance.info(`Skipping ${deviceName} - uses CUDA backend`, serviceName)
        continue
      }

      // Skip Microsoft Basic Display Adapter and other virtual/software devices
      if (
        deviceName.toLowerCase().includes('microsoft basic') ||
        deviceName.toLowerCase().includes('remote') ||
        deviceName.toLowerCase().includes('virtual')
      ) {
        appLoggerInstance.info(`Skipping virtual/software device: ${deviceName}`, serviceName)
        continue
      }

      appLoggerInstance.info(
        `Found Vulkan-capable GPU: ${deviceName} (PNP: ${pnpDeviceId})`,
        serviceName,
      )

      devices.push({
        id: deviceIndex.toString(),
        name: deviceName,
      })

      deviceIndex++
    }

    appLoggerInstance.info(
      `Detected ${devices.length} Vulkan-capable GPU(s) on Windows`,
      serviceName,
    )
  } catch (error) {
    appLoggerInstance.warn(`Failed to detect Vulkan GPUs via WMI: ${error}`, serviceName)
  }

  return devices
}

/**
 * Detect Vulkan-capable GPUs on Linux using lspci
 */
async function detectVulkanGpusLinux(serviceName: string): Promise<VulkanDevice[]> {
  const devices: VulkanDevice[] = []

  try {
    // Use lspci to list VGA/Display/3D controllers
    const { stdout } = await execAsync('lspci | grep -E "VGA|Display|3D"', {
      timeout: 10000,
    })

    const lines = stdout
      .split('\n')
      .map((l) => l.trim())
      .filter((line) => line !== '')

    let deviceIndex = 0
    for (const line of lines) {
      // Format: "00:02.0 VGA compatible controller: Intel Corporation Device"
      // or "01:00.0 VGA compatible controller: Advanced Micro Devices, Inc. [AMD/ATI] Device"

      const match = line.match(/:\s+(.+):\s+(.+)/)
      if (!match) continue

      const deviceName = match[2].trim()

      // Skip NVIDIA devices - they use CUDA backend
      if (isNvidiaDevice(deviceName)) {
        appLoggerInstance.info(`Skipping ${deviceName} - uses CUDA backend`, serviceName)
        continue
      }

      // Intel devices are included - they use Vulkan backend for llama.cpp on Linux

      appLoggerInstance.info(`Found Vulkan-capable GPU: ${deviceName}`, serviceName)

      devices.push({
        id: deviceIndex.toString(),
        name: deviceName,
      })

      deviceIndex++
    }

    appLoggerInstance.info(`Detected ${devices.length} Vulkan-capable GPU(s) on Linux`, serviceName)
  } catch (error) {
    appLoggerInstance.warn(`Failed to detect Vulkan GPUs via lspci: ${error}`, serviceName)
  }

  return devices
}

/**
 * Detect Vulkan-capable GPUs on macOS using system_profiler
 */
async function detectVulkanGpusMac(serviceName: string): Promise<VulkanDevice[]> {
  const devices: VulkanDevice[] = []

  try {
    // Use system_profiler to get graphics/display info
    const { stdout } = await execAsync('system_profiler SPDisplaysDataType', {
      timeout: 10000,
    })

    const lines = stdout.split('\n')

    let deviceIndex = 0

    for (const line of lines) {
      const trimmed = line.trim()

      // Look for chipset/model lines
      if (trimmed.startsWith('Chipset Model:') || trimmed.startsWith('Model:')) {
        const deviceName = trimmed.split(':')[1]?.trim()
        if (deviceName) {
          // On macOS, most GPUs can use Metal or Vulkan via MoltenVK
          // Intel, Apple Silicon, and other GPUs are included for Vulkan support

          if (isNvidiaDevice(deviceName)) {
            appLoggerInstance.info(`Skipping ${deviceName} - uses CUDA backend`, serviceName)
            continue
          }

          appLoggerInstance.info(`Found Vulkan-capable GPU: ${deviceName}`, serviceName)

          devices.push({
            id: deviceIndex.toString(),
            name: deviceName,
          })

          deviceIndex++
        }
      }
    }

    appLoggerInstance.info(`Detected ${devices.length} Vulkan-capable GPU(s) on macOS`, serviceName)
  } catch (error) {
    appLoggerInstance.warn(
      `Failed to detect Vulkan GPUs via system_profiler: ${error}`,
      serviceName,
    )
  }

  return devices
}

/**
 * Check if a device name indicates a Vulkan-capable GPU
 * (e.g., Intel Arc, generic GPUs, but not NVIDIA which uses CUDA)
 */
export function isVulkanDevice(deviceName: string): boolean {
  const lowerName = deviceName.toLowerCase()

  // Don't treat NVIDIA as Vulkan devices - they use CUDA
  if (isNvidiaDevice(deviceName)) {
    return false
  }

  // Intel Arc GPUs use Vulkan backend for llama.cpp
  if (isIntelDevice(deviceName)) {
    return true
  }

  // Other GPU vendors that would use Vulkan
  // Check for generic patterns that indicate a GPU
  if (
    lowerName.includes('gpu') ||
    lowerName.includes('graphics') ||
    lowerName.includes('display')
  ) {
    return true
  }

  return false
}
