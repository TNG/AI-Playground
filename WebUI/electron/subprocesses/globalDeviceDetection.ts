import { promisify } from 'node:util'
import { exec } from 'node:child_process'
import { appLoggerInstance } from '../logging/logger.ts'

const execAsync = promisify(exec)

export type GlobalDevice = {
  id: string // Unique ID like "nvidia-0", "intel-arc-0", "amd-0", "cpu"
  name: string
  type: 'nvidia' | 'intel-arc' | 'amd' | 'cpu'
  rawId: string // Original ID from detection (e.g., "0" for CUDA device 0)
}

let cachedDevices: GlobalDevice[] | null = null

/**
 * Detect all available devices in the system
 * This runs once at app startup and caches the result
 */
export async function detectAllDevices(): Promise<GlobalDevice[]> {
  if (cachedDevices) {
    return cachedDevices
  }

  appLoggerInstance.info('Starting global device detection', 'globalDeviceDetection')

  const devices: GlobalDevice[] = []

  // Detect NVIDIA GPUs
  const nvidiaDevices = await detectNvidiaDevices()
  devices.push(...nvidiaDevices)

  // Detect Intel Arc GPUs
  const intelDevices = await detectIntelArcDevices()
  devices.push(...intelDevices)

  // Detect AMD GPUs (for future support)
  const amdDevices = await detectAmdDevices()
  devices.push(...amdDevices)

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
 * Get cached devices (returns empty array if not detected yet)
 */
export function getCachedDevices(): GlobalDevice[] {
  return cachedDevices || []
}

/**
 * Clear the device cache (for testing purposes)
 */
export function clearDeviceCache(): void {
  cachedDevices = null
}

/**
 * Detect NVIDIA GPUs using nvidia-smi
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
 * Detect Intel Arc GPUs using xpu-smi
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
 * Detect AMD GPUs (placeholder for future support)
 */
async function detectAmdDevices(): Promise<GlobalDevice[]> {
  // AMD detection would go here using rocm-smi or similar
  // For now, return empty array
  return []
}

/**
 * Filter devices by type(s)
 */
export function filterDevicesByType(
  devices: GlobalDevice[],
  types: GlobalDevice['type'][],
): GlobalDevice[] {
  return devices.filter((d) => types.includes(d.type))
}

/**
 * Check if any NVIDIA GPU is available
 */
export function hasNvidiaGpu(devices: GlobalDevice[]): boolean {
  return devices.some((d) => d.type === 'nvidia')
}

/**
 * Check if any Intel Arc GPU is available
 */
export function hasIntelArcGpu(devices: GlobalDevice[]): boolean {
  return devices.some((d) => d.type === 'intel-arc')
}

/**
 * Get device by ID
 */
export function getDeviceById(devices: GlobalDevice[], id: string): GlobalDevice | undefined {
  return devices.find((d) => d.id === id)
}
