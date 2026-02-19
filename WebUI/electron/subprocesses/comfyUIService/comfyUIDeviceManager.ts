import * as filesystem from 'fs-extra'
import { AppLogger } from '../../logging/logger.ts'
import { ComfyUIPaths, ComfyUIDeviceType } from './comfyUITypes.ts'
import { getCachedDevices, filterDevicesByType } from '../globalDeviceDetection.ts'

/**
 * Manages device detection and selection for ComfyUI
 */
export class ComfyUIDeviceManager {
  private readonly paths: ComfyUIPaths
  private readonly appLogger: AppLogger
  private readonly serviceName: BackendServiceName
  private devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  private deviceType: ComfyUIDeviceType = 'CPU'
  private isDeviceSwitching = false

  hasIntelArcGpu = false
  hasNvidiaGpu = false

  constructor(
    paths: ComfyUIPaths,
    appLogger: AppLogger,
    serviceName: BackendServiceName,
    hasIntelArcGpu: boolean,
    hasNvidiaGpu: boolean,
  ) {
    this.paths = paths
    this.appLogger = appLogger
    this.serviceName = serviceName
    this.hasIntelArcGpu = hasIntelArcGpu
    this.hasNvidiaGpu = hasNvidiaGpu
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
   * Get the current device type
   */
  getDeviceType(): ComfyUIDeviceType {
    return this.deviceType
  }

  /**
   * Check if device switching is in progress
   */
  isDeviceSwitchInProgress(): boolean {
    return this.isDeviceSwitching
  }

  /**
   * Set device switching state
   */
  setDeviceSwitching(switching: boolean): void {
    this.isDeviceSwitching = switching
  }

  /**
   * Update GPU availability flags
   */
  updateGpuAvailability(hasIntelArcGpu: boolean, hasNvidiaGpu: boolean): void {
    this.hasIntelArcGpu = hasIntelArcGpu
    this.hasNvidiaGpu = hasNvidiaGpu
  }

  /**
   * Detect all available devices for ComfyUI
   */
  async detectDevices(): Promise<void> {
    const globalDevices = getCachedDevices()
    const supportedDevices = filterDevicesByType(globalDevices, ['nvidia', 'intel-arc', 'cpu'])

    this.appLogger.info(
      `ComfyUI detected ${supportedDevices.length} supported devices: ${JSON.stringify(supportedDevices, null, 2)}`,
      this.serviceName,
    )

    // Remember the currently selected device before recreating the devices list
    const previouslySelectedDevice = this.devices.find((d) => d.selected)
    const previousDeviceType = this.deviceType

    // Check if this is the first time detectDevices is being called (initial state has only '*' device)
    const isFirstDetection = this.devices.length === 1 && this.devices[0].id === '*'

    if (supportedDevices.length === 0) {
      this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
      this.deviceType = 'CPU'
      this.appLogger.warn('No supported devices found, using CPU only', this.serviceName)
    } else {
      const cpuDevice = supportedDevices.find((d) => d.type === 'cpu')
      const gpuDevices = supportedDevices.filter((d) => d.type !== 'cpu')

      // Check if previously selected device is still available
      const previousStillAvailable =
        previouslySelectedDevice &&
        supportedDevices.some((d) => d.id === previouslySelectedDevice.id)

      // Determine which device should be selected
      let selectedId: string | null = null
      let selectedDeviceType: ComfyUIDeviceType = 'CPU'

      if (previousStillAvailable) {
        // Preserve the previous selection
        selectedId = previouslySelectedDevice.id
        selectedDeviceType = previousDeviceType
        this.appLogger.info(
          `Preserving previous device selection: ${previouslySelectedDevice.name} (${selectedDeviceType})`,
          this.serviceName,
        )
      } else if (isFirstDetection) {
        // First time detection: default to CPU to avoid unexpected GPU usage
        // User can explicitly select GPU if they want
        if (cpuDevice) {
          selectedId = cpuDevice.id
          selectedDeviceType = 'CPU'
          this.appLogger.info(
            'First device detection: defaulting to CPU (GPU available but not auto-selected)',
            this.serviceName,
          )
        }
      } else {
        // Subsequent detection without previous selection: use priority order
        // Priority: CUDA > XPU > CPU (select GPU if venv is available)
        const nvidiaDevice = gpuDevices.find((d) => d.type === 'nvidia')
        const intelDevice = gpuDevices.find((d) => d.type === 'intel-arc')

        if (nvidiaDevice && filesystem.existsSync(this.paths.pythonEnvDirCuda)) {
          selectedId = nvidiaDevice.id
          selectedDeviceType = 'CUDA'
          this.appLogger.info('Defaulting to NVIDIA CUDA device', this.serviceName)
        } else if (intelDevice && filesystem.existsSync(this.paths.pythonEnvDirXpu)) {
          selectedId = intelDevice.id
          selectedDeviceType = 'XPU'
          this.appLogger.info('Defaulting to Intel Arc XPU device', this.serviceName)
        } else if (cpuDevice) {
          selectedId = cpuDevice.id
          selectedDeviceType = 'CPU'
          this.appLogger.info('Defaulting to CPU device', this.serviceName)
        }
      }

      const devices: InferenceDevice[] = gpuDevices.map((d) => ({
        id: d.id,
        name: d.name,
        selected: d.id === selectedId,
      }))

      if (cpuDevice) {
        devices.push({
          id: cpuDevice.id,
          name: cpuDevice.name,
          selected: cpuDevice.id === selectedId,
        })
      }

      this.devices = devices
      this.deviceType = selectedDeviceType

      this.appLogger.info(
        `ComfyUI device list updated: selected device is ${selectedId} (${selectedDeviceType})`,
        this.serviceName,
      )
    }
  }

  /**
   * Select a device by ID
   */
  async selectDevice(deviceId: string): Promise<ComfyUIDeviceType | null> {
    if (!this.devices.find((d) => d.id === deviceId)) {
      this.appLogger.warn(`Device ${deviceId} not found in available devices`, this.serviceName)
      return null
    }

    const selectedDevice = this.devices.find((d) => d.selected)
    if (selectedDevice?.id === deviceId) {
      this.appLogger.info(`Device ${deviceId} is already selected`, this.serviceName)
      return null
    }

    // Store old device type to check if restart is needed
    const oldDeviceType = this.deviceType

    this.appLogger.info(
      `Selecting device ${deviceId} (current: ${selectedDevice?.id}, type: ${oldDeviceType})`,
      this.serviceName,
    )

    // Update device selection
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))

    // Determine new device type and check if backend is available
    const [newDeviceType, isBackendAvailable] = this.determineDeviceType(deviceId)
    this.deviceType = newDeviceType

    const deviceName = this.devices.find((d) => d.id === deviceId)?.name ?? deviceId

    if (newDeviceType !== 'CPU' && !isBackendAvailable) {
      this.appLogger.warn(
        `${newDeviceType} backend not available for ${deviceName}, falling back to CPU`,
        this.serviceName,
      )
    } else {
      this.appLogger.info(`Device type set to ${newDeviceType} for ${deviceName}`, this.serviceName)
    }

    // Return the old device type if it changed (signals restart needed)
    return oldDeviceType !== this.deviceType ? oldDeviceType : null
  }

  /**
   * Determine device type based on selected device and available venvs
   * Returns tuple of [deviceType, isAvailable]
   */
  private determineDeviceType(deviceId: string): [ComfyUIDeviceType, boolean] {
    const globalDevices = getCachedDevices()
    const globalDevice = globalDevices.find((d) => d.id === deviceId)

    if (deviceId === 'cpu' || globalDevice?.type === 'cpu') {
      return ['CPU', true]
    }

    if (globalDevice?.type === 'nvidia') {
      return filesystem.existsSync(this.paths.pythonEnvDirCuda) ? ['CUDA', true] : ['CPU', false]
    }

    if (globalDevice?.type === 'intel-arc') {
      return filesystem.existsSync(this.paths.pythonEnvDirXpu) ? ['XPU', true] : ['CPU', false]
    }

    return ['CPU', false]
  }
}
