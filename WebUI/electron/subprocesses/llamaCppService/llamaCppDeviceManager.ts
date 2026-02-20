import { AppLogger } from '../../logging/logger.ts'
import { promisify } from 'util'
import { exec } from 'child_process'
import { LlamaCppPaths } from './llamaCppTypes.ts'
import * as filesystem from 'fs-extra'
import { getCachedDevices, filterDevicesByType } from '../globalDeviceDetection.ts'

const execAsync = promisify(exec)

/**
 * Manages device detection and selection for LlamaCPP
 */
export class LlamaCppDeviceManager {
  private readonly paths: LlamaCppPaths
  private readonly appLogger: AppLogger
  private readonly serviceName: BackendServiceName
  // Startup default placeholder — replaced once detectDevices() runs.
  // Consumers should call detectDevices() (or await an initialization that triggers it)
  // before relying on this list for accurate device information.
  private devices: InferenceDevice[] = [{ id: '0', name: 'Auto select device', selected: true }]

  constructor(paths: LlamaCppPaths, appLogger: AppLogger, serviceName: BackendServiceName) {
    this.paths = paths
    this.appLogger = appLogger
    this.serviceName = serviceName
  }

  /**
   * Get all available devices
   */
  getDevices(): InferenceDevice[] {
    return this.devices
  }

  /**
   * Get the currently selected device
   */
  getSelectedDevice(): InferenceDevice | undefined {
    return this.devices.find((d) => d.selected)
  }

  /**
   * Select a device by ID
   */
  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) return
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))
  }

  /**
   * Detect all available devices for LlamaCPP
   */
  async detectDevices(): Promise<void> {
    try {
      this.appLogger.info('Using global device detection for LlamaCPP', this.serviceName)

      const globalDevices = getCachedDevices()

      if (globalDevices.length === 0) {
        this.appLogger.warn('No devices found in global cache, using CPU only', this.serviceName)
        this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
        return
      }

      // Filter devices that work with LlamaCPP (NVIDIA, Intel Arc, AMD, and CPU)
      // Note: LlamaCPP uses Vulkan backend which supports NVIDIA, Intel Arc, and AMD GPUs
      const supportedGpuDevices = filterDevicesByType(globalDevices, ['nvidia', 'intel-arc', 'amd'])

      // Map global devices to InferenceDevice format
      const deviceList: InferenceDevice[] = []

      // Verify device availability with llama-server if it exists
      const verifiedDevices: string[] = []
      if (filesystem.existsSync(this.paths.llamaCppExePath)) {
        try {
          this.appLogger.info(
            'Verifying devices with llama-server --list-devices',
            this.serviceName,
          )
          const { stdout } = await execAsync(`"${this.paths.llamaCppExePath}" --list-devices`, {
            cwd: this.paths.llamaCppDir,
            env: {
              ...process.env,
            },
            timeout: 10000,
          })

          // Parse the output to get Vulkan device IDs
          const lines = stdout.split('\n').map((line) => line.trim())
          let foundDevicesSection = false
          for (const line of lines) {
            if (line.startsWith('Available devices:')) {
              foundDevicesSection = true
              continue
            }

            if (foundDevicesSection && line.includes(':')) {
              const colonIndex = line.indexOf(':')
              if (colonIndex > 0) {
                let deviceId = line.substring(0, colonIndex).trim()
                // Strip "Vulkan" prefix from device ID
                if (deviceId.startsWith('Vulkan')) {
                  deviceId = deviceId.substring(6)
                }
                verifiedDevices.push(deviceId)
              }
            }
          }
          this.appLogger.info(
            `Verified Vulkan devices: ${JSON.stringify(verifiedDevices)}`,
            this.serviceName,
          )
        } catch (error) {
          this.appLogger.warn(
            `Failed to verify devices with llama-server: ${error}`,
            this.serviceName,
          )
        }
      }

      // Add GPU devices (only if they're verified or if we couldn't verify)
      if (supportedGpuDevices.length > 0) {
        for (let i = 0; i < supportedGpuDevices.length; i++) {
          const device = supportedGpuDevices[i]
          // If we have verified devices, only add this device if it's in the list
          // Otherwise, add all detected devices
          const deviceIndex = i.toString()
          if (verifiedDevices.length === 0 || verifiedDevices.includes(deviceIndex)) {
            deviceList.push({
              id: deviceIndex,
              name: device.name,
              selected: i === 0, // First GPU is selected by default
            })
          }
        }
      }

      // Always add CPU as last option
      deviceList.push({
        id: 'cpu',
        name: 'CPU',
        selected: deviceList.length === 0, // CPU is selected by default if no GPUs
      })

      this.devices = deviceList
      this.appLogger.info(
        `LlamaCPP devices available: ${this.devices.length} (${supportedGpuDevices.length} GPU(s) + CPU)`,
        this.serviceName,
      )
      this.appLogger.info(
        `Device details: ${JSON.stringify(this.devices, null, 2)}`,
        this.serviceName,
      )
    } catch (error) {
      this.appLogger.error(`Failed to detect devices: ${error}`, this.serviceName)
      // Fallback to CPU on error
      this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
    }
  }
}
