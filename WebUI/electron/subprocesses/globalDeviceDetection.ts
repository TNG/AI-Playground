import { promisify } from 'node:util'
import { exec } from 'node:child_process'
import { appLoggerInstance } from '../logging/logger.ts'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { app } from 'electron'

const execAsync = promisify(exec)

export type GlobalDevice = {
  id: string // Unique ID like "nvidia-0", "intel-arc-0", "amd-0", "cpu"
  name: string
  type: 'nvidia' | 'intel-arc' | 'amd' | 'cpu'
  rawId: string // Original ID from detection (e.g., "0" for CUDA device 0)
}

let cachedDevices: GlobalDevice[] | null = null

/**
 * Detects and returns all compute devices available on the system and caches the result for subsequent calls.
 *
 * Detection prefers a Vulkan-based enumeration and falls back to vendor-specific discovery methods when Vulkan is unavailable. A CPU device is always included in the returned list.
 *
 * @returns An array of `GlobalDevice` entries representing discovered devices (GPUs and a CPU). The returned list is cached so subsequent calls return the previously detected devices.
 */
export async function detectAllDevices(): Promise<GlobalDevice[]> {
  if (cachedDevices) {
    return cachedDevices
  }

  appLoggerInstance.info('Starting global device detection', 'globalDeviceDetection')

  const devices: GlobalDevice[] = []

  // Try Vulkan detection first (via llama-server) - this detects ALL GPU types
  const vulkanDevices = await detectVulkanDevices()

  if (vulkanDevices.length > 0) {
    // If Vulkan detection found devices, use those
    devices.push(...vulkanDevices)
    appLoggerInstance.info(
      `Using Vulkan-based detection, found ${vulkanDevices.length} GPU(s)`,
      'globalDeviceDetection',
    )
  } else {
    // Fall back to specific detection methods
    appLoggerInstance.info(
      'Vulkan detection unavailable, using specific detection methods',
      'globalDeviceDetection',
    )

    // Detect NVIDIA GPUs
    const nvidiaDevices = await detectNvidiaDevices()
    devices.push(...nvidiaDevices)

    // Detect Intel Arc GPUs
    const intelDevices = await detectIntelArcDevices()
    devices.push(...intelDevices)

    // Detect AMD GPUs
    const amdDevices = await detectAmdDevices()
    devices.push(...amdDevices)
  }

  // Always add CPU
  devices.push({
    id: 'cpu',
    name: 'CPU',
    type: 'cpu',
    rawId: 'cpu',
  })

  cachedDevices = devices
  appLoggerInstance.info(
    `Global device detection complete: ${devices.length} devices found`,
    'globalDeviceDetection',
  )
  appLoggerInstance.info(
    `Detected devices: ${JSON.stringify(devices, null, 2)}`,
    'globalDeviceDetection',
  )

  return devices
}

/**
 * Retrieve the last-detected global devices from cache.
 *
 * @returns The cached array of GlobalDevice objects, or an empty array if device detection has not been run yet.
 */
export function getCachedDevices(): GlobalDevice[] {
  return cachedDevices || []
}

/**
 * Resets the cached device list so subsequent detection performs a fresh scan.
 */
export function clearDeviceCache(): void {
  cachedDevices = null
}

/**
 * Detect available GPUs by querying llama-server's Vulkan device list.
 *
 * Parses the output from the llama-server Vulkan device listing and returns a
 * GlobalDevice entry for each detected GPU (NVIDIA, Intel Arc, or AMD). If the
 * llama-server binary is not available, parsing fails, or no GPUs are found,
 * an empty array is returned.
 *
 * @returns An array of detected GlobalDevice objects; an empty array if no GPUs are detected or detection fails.
 */
async function detectVulkanDevices(): Promise<GlobalDevice[]> {
  try {
    // Locate llama-server.exe
    const baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
    const llamaCppDir = path.resolve(path.join(baseDir, 'LlamaCPP', 'llama-cpp'))
    const binaryName = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
    const llamaCppExePath = path.resolve(path.join(llamaCppDir, binaryName))

    // Check if llama-server exists
    if (!filesystem.existsSync(llamaCppExePath)) {
      appLoggerInstance.info(
        'llama-server not found, skipping Vulkan detection',
        'globalDeviceDetection',
      )
      return []
    }

    appLoggerInstance.info(
      'Detecting devices using llama-server --list-devices',
      'globalDeviceDetection',
    )

    // Execute llama-server --list-devices
    const { stdout } = await execAsync(`"${llamaCppExePath}" --list-devices`, {
      cwd: llamaCppDir,
      env: {
        ...process.env,
      },
      timeout: 10000,
    })

    // Parse the output
    const devices: GlobalDevice[] = []
    const lines = stdout.split('\n').map((line) => line.trim())

    let foundDevicesSection = false
    for (const line of lines) {
      if (line.startsWith('Available devices:')) {
        foundDevicesSection = true
        continue
      }

      if (foundDevicesSection && line.includes(':')) {
        // Parse lines like "Vulkan0: NVIDIA GeForce RTX 4060 Laptop GPU (7824 MiB, 7824 MiB free)"
        const colonIndex = line.indexOf(':')
        if (colonIndex > 0) {
          const vulkanId = line.substring(0, colonIndex).trim()
          const deviceInfo = line.substring(colonIndex + 1).trim()

          // Strip "Vulkan" prefix from device ID (e.g., "Vulkan0" -> "0")
          let deviceIndex = '0'
          if (vulkanId.startsWith('Vulkan')) {
            deviceIndex = vulkanId.substring(6)
          }

          // Extract device name (before memory info in parentheses)
          const lastParenIndex = deviceInfo.lastIndexOf('(')
          let deviceName = deviceInfo

          if (lastParenIndex > 0) {
            const memoryInfo = deviceInfo.substring(lastParenIndex)
            if (
              memoryInfo.includes('MiB') ||
              memoryInfo.includes('GiB') ||
              memoryInfo.includes('free')
            ) {
              deviceName = deviceInfo.substring(0, lastParenIndex).trim()
            }
          }

          // Determine device type based on name
          const lowerName = deviceName.toLowerCase()
          let deviceType: GlobalDevice['type'] = 'nvidia' // default

          if (
            lowerName.includes('nvidia') ||
            lowerName.includes('geforce') ||
            lowerName.includes('rtx') ||
            lowerName.includes('gtx')
          ) {
            deviceType = 'nvidia'
          } else if (
            lowerName.includes('intel') &&
            (lowerName.includes('arc') || lowerName.includes('graphics'))
          ) {
            deviceType = 'intel-arc'
          } else if (
            lowerName.includes('amd') ||
            lowerName.includes('radeon') ||
            lowerName.includes('ati')
          ) {
            deviceType = 'amd'
          }

          devices.push({
            id: `${deviceType}-${deviceIndex}`,
            name: deviceName,
            type: deviceType,
            rawId: deviceIndex,
          })
        }
      }
    }

    if (devices.length > 0) {
      appLoggerInstance.info(
        `Vulkan detected ${devices.length} GPU(s): ${devices.map((d) => `${d.name} (${d.type})`).join(', ')}`,
        'globalDeviceDetection',
      )
    }

    return devices
  } catch (error) {
    appLoggerInstance.info(`Vulkan detection failed: ${error}`, 'globalDeviceDetection')
    return []
  }
}

/**
 * Discovers NVIDIA GPUs available on the host by querying `nvidia-smi`.
 *
 * @returns An array of detected NVIDIA devices as `GlobalDevice` entries; returns an empty array if no NVIDIA GPUs are found or detection fails.
 */
async function detectNvidiaDevices(): Promise<GlobalDevice[]> {
  try {
    const { stdout } = await execAsync('nvidia-smi --query-gpu=index,name --format=csv,noheader', {
      timeout: 5000,
    })

    const lines = stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)

    const devices: GlobalDevice[] = []
    for (const line of lines) {
      const parts = line.split(',').map((p) => p.trim())
      if (parts.length >= 2) {
        const index = parts[0]
        const name = parts[1]
        devices.push({
          id: `nvidia-${index}`,
          name: name,
          type: 'nvidia',
          rawId: index,
        })
      }
    }

    if (devices.length > 0) {
      appLoggerInstance.info(
        `Detected ${devices.length} NVIDIA GPU(s): ${devices.map((d) => d.name).join(', ')}`,
        'globalDeviceDetection',
      )
    }

    return devices
  } catch (_error) {
    appLoggerInstance.info(
      'No NVIDIA GPUs detected (nvidia-smi not found)',
      'globalDeviceDetection',
    )
    return []
  }
}

/**
 * Discover Intel Arc GPUs present on the host and return them as GlobalDevice entries.
 *
 * @returns An array of `GlobalDevice` objects for each detected Intel Arc GPU. The array is empty if no Intel Arc GPUs are found or if detection fails.
 */
async function detectIntelArcDevices(): Promise<GlobalDevice[]> {
  try {
    // Try to use xpu-smi if available
    const deviceServicePath = process.env.XPU_SMI_PATH || 'xpu-smi'

    try {
      const { stdout } = await execAsync(`"${deviceServicePath}" discovery`, { timeout: 10000 })

      // Parse xpu-smi output to extract device information
      const devices: GlobalDevice[] = []
      const lines = stdout.split('\n')

      let deviceIndex = 0
      for (const line of lines) {
        const lower = line.toLowerCase()
        if (
          lower.includes('intel') &&
          (lower.includes('arc') || lower.includes('graphics') || lower.includes('gpu'))
        ) {
          // Extract device name from the line
          const nameMatch = line.match(/Device\s+\d+:\s+(.+)/) || line.match(/:\s+(.+)/)
          const name = nameMatch ? nameMatch[1].trim() : 'Intel Arc Graphics'

          devices.push({
            id: `intel-arc-${deviceIndex}`,
            name: name,
            type: 'intel-arc',
            rawId: `${deviceIndex}`,
          })
          deviceIndex++
        }
      }

      if (devices.length > 0) {
        appLoggerInstance.info(
          `Detected ${devices.length} Intel Arc GPU(s): ${devices.map((d) => d.name).join(', ')}`,
          'globalDeviceDetection',
        )
      }

      return devices
    } catch {
      appLoggerInstance.info('xpu-smi not found or failed', 'globalDeviceDetection')
      return []
    }
  } catch (_error) {
    appLoggerInstance.info('No Intel Arc GPUs detected', 'globalDeviceDetection')
    return []
  }
}

/**
 * Detect AMD Radeon/ATI discrete GPUs on Windows and represent them as GlobalDevice objects.
 *
 * Uses PowerShell to query Win32_VideoController and filters controllers whose names contain
 * "AMD", "Radeon", or "ATI"; integrated/APU graphics are skipped when possible.
 *
 * @returns An array of detected AMD GPU GlobalDevice objects; an empty array if none are found.
 */
async function detectAmdDevices(): Promise<GlobalDevice[]> {
  try {
    // On Windows, we can use WMIC or PowerShell to detect AMD GPUs
    // We'll try PowerShell first as it's more reliable and available on all modern Windows
    const psCommand = `Get-CimInstance -ClassName Win32_VideoController | Where-Object { $_.Name -like '*AMD*' -or $_.Name -like '*Radeon*' -or $_.Name -like '*ATI*' } | ForEach-Object { Write-Output "$($_.PNPDeviceID)|$($_.Name)" }`

    const { stdout } = await execAsync(`powershell -Command "${psCommand}"`, {
      timeout: 10000,
    })

    const lines = stdout
      .trim()
      .split('\n')
      .filter((line) => line.trim().length > 0)

    const devices: GlobalDevice[] = []
    for (let i = 0; i < lines.length; i++) {
      const parts = lines[i].split('|')
      if (parts.length >= 2) {
        const name = parts[1].trim()
        // Only add discrete GPUs (skip APU integrated graphics that might be detected elsewhere)
        devices.push({
          id: `amd-${i}`,
          name: name,
          type: 'amd',
          rawId: `${i}`,
        })
      }
    }

    if (devices.length > 0) {
      appLoggerInstance.info(
        `Detected ${devices.length} AMD GPU(s): ${devices.map((d) => d.name).join(', ')}`,
        'globalDeviceDetection',
      )
    }

    return devices
  } catch (_error) {
    appLoggerInstance.info('No AMD GPUs detected', 'globalDeviceDetection')
    return []
  }
}

/**
 * Return only devices whose type is one of the specified types.
 *
 * @param devices - Array of global devices to filter
 * @param types - Allowed device types to include in the result
 * @returns The subset of `devices` whose `type` is included in `types`
 */
export function filterDevicesByType(
  devices: GlobalDevice[],
  types: GlobalDevice['type'][],
): GlobalDevice[] {
  return devices.filter((d) => types.includes(d.type))
}

/**
 * Determine whether the provided device list contains any NVIDIA GPU.
 *
 * @returns `true` if at least one device has type `'nvidia'`, `false` otherwise.
 */
export function hasNvidiaGpu(devices: GlobalDevice[]): boolean {
  return devices.some((d) => d.type === 'nvidia')
}

/**
 * Determines whether the device list contains any Intel Arc GPU.
 *
 * @returns `true` if the list contains at least one device with type `'intel-arc'`, `false` otherwise.
 */
export function hasIntelArcGpu(devices: GlobalDevice[]): boolean {
  return devices.some((d) => d.type === 'intel-arc')
}

/**
 * Retrieve a device matching the given identifier.
 *
 * @param devices - The array of devices to search.
 * @param id - The device id to find.
 * @returns The matching `GlobalDevice` if found, `undefined` otherwise.
 */
export function getDeviceById(devices: GlobalDevice[], id: string): GlobalDevice | undefined {
  return devices.find((d) => d.id === id)
}