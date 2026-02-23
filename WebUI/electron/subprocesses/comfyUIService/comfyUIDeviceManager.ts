import { AppLogger } from '../../logging/logger.ts'
import { ComfyUIDeviceType } from './comfyUITypes.ts'
import { getCachedDevices, filterDevicesByType } from '../globalDeviceDetection.ts'

/**
 * Manages device detection and selection for ComfyUI.
 *
 * CPU is only exposed as a selectable option when no Intel Arc or NVIDIA device is present.
 */
export class ComfyUIDeviceManager {
  private readonly appLogger: AppLogger
  private readonly serviceName: BackendServiceName
  private devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  private deviceType: ComfyUIDeviceType = 'CPU'
  private isDeviceSwitching = false

  hasIntelArcGpu = false
  hasNvidiaGpu = false

  constructor(
    _paths: unknown, // kept for API compatibility, no longer needed
    appLogger: AppLogger,
    serviceName: BackendServiceName,
    hasIntelArcGpu: boolean,
    hasNvidiaGpu: boolean,
  ) {
    this.appLogger = appLogger
    this.serviceName = serviceName
    this.hasIntelArcGpu = hasIntelArcGpu
    this.hasNvidiaGpu = hasNvidiaGpu
  }

  /** Get all available devices */
  getDevices(): InferenceDevice[] {
    return this.devices
  }

  /** Get the currently selected device */
  getSelectedDevice(): InferenceDevice | undefined {
    return this.devices.find((d) => d.selected)
  }

  /** Get the current device type */
  getDeviceType(): ComfyUIDeviceType {
    return this.deviceType
  }

  /** Check if device switching is in progress */
  isDeviceSwitchInProgress(): boolean {
    return this.isDeviceSwitching
  }

  /** Set device switching state */
  setDeviceSwitching(switching: boolean): void {
    this.isDeviceSwitching = switching
  }

  /** Update GPU availability flags */
  updateGpuAvailability(hasIntelArcGpu: boolean, hasNvidiaGpu: boolean): void {
    this.hasIntelArcGpu = hasIntelArcGpu
    this.hasNvidiaGpu = hasNvidiaGpu
  }

  /**
   * Detect all available devices for ComfyUI.
   * CPU is only included when no GPU devices are present.
   */
  async detectDevices(): Promise<void> {
    const globalDevices = getCachedDevices()
    const supportedDevices = filterDevicesByType(globalDevices, ['nvidia', 'intel-arc', 'cpu'])

    this.appLogger.info(
      `ComfyUI detected ${supportedDevices.length} supported devices: ${JSON.stringify(supportedDevices, null, 2)}`,
      this.serviceName,
    )

    const gpuDevices = supportedDevices.filter((d) => d.type !== 'cpu')
    const cpuDevice = supportedDevices.find((d) => d.type === 'cpu')

    // Remember the currently selected device
    const previouslySelectedDevice = this.devices.find((d) => d.selected)
    const previousDeviceType = this.deviceType

    if (gpuDevices.length === 0) {
      // No GPUs — CPU is the only option
      this.devices = [
        { id: cpuDevice?.id ?? 'cpu', name: cpuDevice?.name ?? 'CPU', selected: true },
      ]
      this.deviceType = 'CPU'
      this.appLogger.warn('No GPU devices found, using CPU only', this.serviceName)
      return
    }

    // GPUs present — CPU is NOT offered as an option
    const previousStillAvailable =
      previouslySelectedDevice && gpuDevices.some((d) => d.id === previouslySelectedDevice.id)

    let selectedId: string | null = null
    let selectedDeviceType: ComfyUIDeviceType = 'CPU'

    if (previousStillAvailable) {
      selectedId = previouslySelectedDevice.id
      selectedDeviceType = previousDeviceType
      this.appLogger.info(
        `Preserving previous device selection: ${previouslySelectedDevice.name} (${selectedDeviceType})`,
        this.serviceName,
      )
    } else {
      // Default: prefer NVIDIA, then Intel Arc
      const nvidiaDevice = gpuDevices.find((d) => d.type === 'nvidia')
      const intelDevice = gpuDevices.find((d) => d.type === 'intel-arc')
      if (nvidiaDevice) {
        selectedId = nvidiaDevice.id
        selectedDeviceType = 'CUDA'
        this.appLogger.info('Defaulting to NVIDIA CUDA device', this.serviceName)
      } else if (intelDevice) {
        selectedId = intelDevice.id
        selectedDeviceType = 'XPU'
        this.appLogger.info('Defaulting to Intel Arc XPU device', this.serviceName)
      }
    }

    this.devices = gpuDevices.map((d) => ({
      id: d.id,
      name: d.name,
      selected: d.id === selectedId,
    }))
    this.deviceType = selectedDeviceType

    this.appLogger.info(
      `ComfyUI device list updated: selected device is ${selectedId} (${selectedDeviceType})`,
      this.serviceName,
    )
  }

  /**
   * Select a device by ID and return the old device type if it changed (signals restart needed),
   * or null if nothing changed.
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

    const oldDeviceType = this.deviceType

    this.appLogger.info(
      `Selecting device ${deviceId} (current: ${selectedDevice?.id}, type: ${oldDeviceType})`,
      this.serviceName,
    )

    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))

    const newDeviceType = this.determineDeviceType(deviceId)
    this.deviceType = newDeviceType

    const deviceName = this.devices.find((d) => d.id === deviceId)?.name ?? deviceId
    this.appLogger.info(`Device type set to ${newDeviceType} for ${deviceName}`, this.serviceName)

    return oldDeviceType !== this.deviceType ? oldDeviceType : null
  }

  /**
   * Determine the device type for a given device ID based on cached global device list.
   * CPU is only returned for explicit cpu-type devices.
   */
  private determineDeviceType(deviceId: string): ComfyUIDeviceType {
    const globalDevices = getCachedDevices()
    const globalDevice = globalDevices.find((d) => d.id === deviceId)

    if (deviceId === 'cpu' || globalDevice?.type === 'cpu') return 'CPU'
    if (globalDevice?.type === 'nvidia') return 'CUDA'
    if (globalDevice?.type === 'intel-arc') return 'XPU'

    return 'CPU'
  }
}
