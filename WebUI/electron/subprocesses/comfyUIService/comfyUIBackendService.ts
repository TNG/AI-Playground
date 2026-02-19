import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { LongLivedPythonApiService } from '../service.ts'
import { aipgBaseDir } from '../uvBasedBackends/uv.ts'
import { getMediaDir } from '../../utils.ts'
import { levelZeroDeviceSelectorEnv, cudaDeviceSelectorEnv } from '../deviceDetection.ts'
import { getCachedDevices } from '../globalDeviceDetection.ts'
import { BrowserWindow } from 'electron'
import { LocalSettings } from '../../main.ts'
import { ComfyUIPaths } from './comfyUITypes.ts'
import { ComfyUIInstaller } from './comfyUIInstaller.ts'
import { ComfyUIDeviceManager } from './comfyUIDeviceManager.ts'

export const COMFYUI_DEFAULT_PARAMETERS = '--lowvram --reserve-vram 6.0'

/**
 * Main service class that orchestrates ComfyUI backend operations
 */
export class ComfyUiBackendService extends LongLivedPythonApiService {
  readonly isRequired = false
  readonly serviceFolder = 'ComfyUI'
  readonly baseDir = path.resolve(aipgBaseDir)
  readonly serviceDir = path.resolve(path.join(this.baseDir, this.serviceFolder))

  // Service paths
  private readonly paths: ComfyUIPaths

  healthEndpointUrl = `${this.baseUrl}/queue`

  private environmentMismatchError: ErrorDetails | null = null
  private comfyUiParametersString: string = COMFYUI_DEFAULT_PARAMETERS
  private currentRunningDeviceType: 'CPU' | 'CUDA' | 'XPU' | null = null

  // Sub-components
  private readonly installer: ComfyUIInstaller
  private readonly deviceManager: ComfyUIDeviceManager

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    super(name, port, win, settings)

    // Set up paths
    const pythonEnvDirCpu = path.resolve(path.join(this.serviceDir, '.venv-cpu'))
    const pythonEnvDirXpu = path.resolve(path.join(this.serviceDir, '.venv-xpu'))
    const pythonEnvDirCuda = path.resolve(path.join(this.serviceDir, '.venv-cuda'))

    this.paths = {
      baseDir: this.baseDir,
      serviceDir: this.serviceDir,
      pythonEnvDirCpu,
      pythonEnvDirXpu,
      pythonEnvDirCuda,
    }

    // Initialize sub-components
    this.installer = new ComfyUIInstaller(
      this.paths,
      this.appLogger,
      this.name,
      this.win,
      'v0.3.66',
    )
    this.deviceManager = new ComfyUIDeviceManager(
      this.paths,
      this.appLogger,
      this.name,
      false,
      false,
    )

    this.serviceIsSetUp().then(async (setUp) => {
      this.isSetUp = setUp
      if (this.isSetUp) {
        await this.updateCachedVersion()
        this.setStatus('notYetStarted')
      }
      this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)
    })
  }

  get pythonEnvDir(): string {
    const deviceType = this.deviceManager.getDeviceType()
    switch (deviceType) {
      case 'CPU':
        return this.paths.pythonEnvDirCpu
      case 'CUDA':
        return this.paths.pythonEnvDirCuda
      case 'XPU':
        return this.paths.pythonEnvDirXpu
    }
  }

  get devices(): InferenceDevice[] {
    return this.deviceManager.getDevices()
  }

  async serviceIsSetUp(): Promise<boolean> {
    const isSetUp = await this.installer.serviceIsSetUp()
    if (isSetUp) {
      // Update device manager with GPU availability
      this.deviceManager.updateGpuAvailability(
        this.installer.hasIntelArcGpu,
        this.installer.hasNvidiaGpu,
      )
    }
    return isSetUp
  }

  isSetUp = false

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.version) {
      this.installer.updateVersion(settings.version)
      this.appLogger.info(`applied new comfyUI version ${settings.version}`, this.name)
    }
    if (typeof settings.comfyUiParameters === 'string') {
      this.comfyUiParametersString = settings.comfyUiParameters
      this.appLogger.info(
        `applied new comfyUI startup parameters: ${this.comfyUiParametersString}`,
        this.name,
      )
    }
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    return await this.installer.getInstalledVersion()
  }

  get_info(): ApiServiceInformation {
    const baseInfo = super.get_info()

    // Always show environment mismatch error if it exists, even if there's a startup error
    // This guides users toward a potential fix (reinstallation)
    if (this.environmentMismatchError) {
      if (baseInfo.errorDetails) {
        // Merge environment mismatch with startup error
        const mergedError: ErrorDetails = {
          command: baseInfo.errorDetails.command || this.environmentMismatchError.command,
          exitCode: baseInfo.errorDetails.exitCode ?? this.environmentMismatchError.exitCode,
          stdout: [
            '=== Environment Mismatch Warning ===',
            this.environmentMismatchError.stdout,
            '',
            '=== Startup Error Details ===',
            baseInfo.errorDetails.stdout || 'No stdout output',
          ].join('\n'),
          stderr: [
            '=== Environment Mismatch Warning ===',
            this.environmentMismatchError.stderr,
            '',
            '=== Startup Error Details ===',
            baseInfo.errorDetails.stderr || 'No stderr output',
          ].join('\n'),
          timestamp: baseInfo.errorDetails.timestamp || this.environmentMismatchError.timestamp,
          duration: baseInfo.errorDetails.duration ?? this.environmentMismatchError.duration,
          pipFreezeOutput:
            baseInfo.errorDetails.pipFreezeOutput || this.environmentMismatchError.pipFreezeOutput,
        }
        return {
          ...baseInfo,
          errorDetails: mergedError,
        }
      } else {
        // Only environment mismatch error, no startup error
        return {
          ...baseInfo,
          errorDetails: this.environmentMismatchError,
        }
      }
    }

    return baseInfo
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.appLogger.info('setting up service', this.name)
    this.setStatus('installing')

    for await (const progress of this.installer.setup()) {
      yield progress

      // Check if setup completed successfully
      if (progress.status === 'success') {
        this.isSetUp = true
        await this.updateCachedVersion()
        this.setStatus('notYetStarted')

        // Update device manager with GPU availability
        this.deviceManager.updateGpuAvailability(
          this.installer.hasIntelArcGpu,
          this.installer.hasNvidiaGpu,
        )
      } else if (progress.status === 'failed') {
        this.setStatus('installationFailed')
      }
    }
  }

  getEnvVars(): Record<string, string | undefined> {
    const selectedDevice = this.deviceManager.getSelectedDevice()
    const baseEnv: Record<string, string | undefined> = {
      PATH: `${path.join(this.pythonEnvDir, 'Library', 'bin')};${path.join(this.installer.getGitDir(), 'cmd')};${process.env.PATH}`,
      PYTHONNOUSERSITE: 'true',
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      PYTHONIOENCODING: 'utf-8',
      HF_ENDPOINT: this.settings.huggingfaceEndpoint,
      PIP_CONFIG_FILE: 'nul',
      UV_NO_CONFIG: '1',
      UV_TORCH_BACKEND: process.platform === 'win32' ? 'xpu' : undefined,
    }

    if (!selectedDevice) {
      return baseEnv
    }

    const deviceType = this.deviceManager.getDeviceType()

    if (deviceType === 'CPU') {
      this.appLogger.info('Using CPU mode for ComfyUI', this.name)
      return {
        ...baseEnv,
        CUDA_VISIBLE_DEVICES: '',
        ONEAPI_DEVICE_SELECTOR: '',
        DISABLE_IPEX: '1',
      }
    }

    const globalDevices = getCachedDevices()
    const globalDevice = globalDevices.find((d) => d.id === selectedDevice.id)

    if (deviceType === 'CUDA') {
      this.appLogger.info(`Using CUDA mode for ComfyUI (device: ${selectedDevice.name})`, this.name)
      return {
        ...baseEnv,
        ...cudaDeviceSelectorEnv(globalDevice!.rawId),
        ONEAPI_DEVICE_SELECTOR: '',
      }
    }

    if (deviceType === 'XPU') {
      this.appLogger.info(`Using XPU mode for ComfyUI (device: ${selectedDevice.name})`, this.name)
      return {
        ...baseEnv,
        ...levelZeroDeviceSelectorEnv(globalDevice!.rawId),
        CUDA_VISIBLE_DEVICES: '',
      }
    }

    return baseEnv
  }

  getPythonBinaryPath() {
    return path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
  }

  async detectDevices() {
    await this.deviceManager.detectDevices()
    this.updateStatus()
  }

  async selectDevice(deviceId: string): Promise<void> {
    // Prevent concurrent device switches
    if (this.deviceManager.isDeviceSwitchInProgress()) {
      this.appLogger.warn('Device switch already in progress, ignoring request', this.name)
      return
    }

    const wasRunning = this.currentStatus === 'running'
    const oldDeviceType = await this.deviceManager.selectDevice(deviceId)

    this.updateStatus()

    // If device type changed and service is running, restart it
    if (oldDeviceType !== null && wasRunning) {
      await this.restartWithNewDevice(oldDeviceType)
    } else if (oldDeviceType !== null && !wasRunning) {
      this.appLogger.info(
        `Device type changed to ${this.deviceManager.getDeviceType()}, but service was not running. Will use new device on next start.`,
        this.name,
      )
    }
  }

  /**
   * Check if the currently running backend matches the selected device.
   * If not, restart with the correct backend.
   * This is called before executing any workflow to ensure the right backend is active.
   * @returns Object indicating if a restart was triggered
   */
  async ensureCorrectBackendRunning(): Promise<{ restarted: boolean; starting: boolean }> {
    if (this.deviceManager.isDeviceSwitchInProgress()) {
      this.appLogger.warn('Device switch already in progress, skipping backend check', this.name)
      return { restarted: false, starting: false }
    }

    // Get the device type that should be running based on selected device
    const selectedDevice = this.deviceManager.getSelectedDevice()
    if (!selectedDevice) {
      this.appLogger.warn('No device selected, cannot ensure correct backend', this.name)
      return { restarted: false, starting: false }
    }

    const targetDeviceType = this.deviceManager.getDeviceType()

    // Check if service is running
    if (this.currentStatus === 'running' && this.currentRunningDeviceType) {
      // If backend type doesn't match, restart with correct backend
      if (this.currentRunningDeviceType !== targetDeviceType) {
        this.appLogger.info(
          `Backend mismatch detected: running ${this.currentRunningDeviceType}, need ${targetDeviceType}. Restarting...`,
          this.name,
        )
        await this.restartWithNewDevice(this.currentRunningDeviceType)
        return { restarted: true, starting: false }
      } else {
        this.appLogger.info(
          `Backend check passed: ${this.currentRunningDeviceType} backend is running as expected`,
          this.name,
        )
        return { restarted: false, starting: false }
      }
    } else if (this.currentStatus !== 'running') {
      // If not running, start with the correct backend
      this.appLogger.info(
        `ComfyUI not running, starting with ${targetDeviceType} backend...`,
        this.name,
      )
      await this.start()
      return { restarted: false, starting: true }
    }

    return { restarted: false, starting: false }
  }

  /**
   * Restart ComfyUI with a new device backend
   */
  private async restartWithNewDevice(oldDeviceType: 'CPU' | 'CUDA' | 'XPU'): Promise<void> {
    this.deviceManager.setDeviceSwitching(true)
    const newDeviceType = this.deviceManager.getDeviceType()
    this.appLogger.info(
      `Device type changed from ${oldDeviceType} to ${newDeviceType}, restarting ComfyUI...`,
      this.name,
    )

    try {
      // Stop the service and wait for it to fully stop
      this.appLogger.info('Stopping ComfyUI for device switch...', this.name)
      await this.stop()

      // Wait longer for GPU resources to be released
      this.appLogger.info('Waiting for GPU resources to be released...', this.name)
      await new Promise((resolve) => setTimeout(resolve, 3000))

      // Verify the process is fully stopped
      if (this.encapsulatedProcess && !this.encapsulatedProcess.killed) {
        this.appLogger.warn('Process still alive, force killing...', this.name)
        this.encapsulatedProcess.kill('SIGKILL')
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }

      // Reset desired status to allow start
      this.desiredStatus = 'stopped'

      // Start with new device
      this.appLogger.info(`Starting ComfyUI with ${newDeviceType} backend...`, this.name)
      await this.start()

      this.appLogger.info('ComfyUI restarted successfully with new device', this.name)
    } catch (error) {
      this.appLogger.error(`Failed to restart ComfyUI after device change: ${error}`, this.name)
      this.setStatus('failed')
    } finally {
      this.deviceManager.setDeviceSwitching(false)
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const additionalEnvVariables = this.getEnvVars()
    const mediaDir = getMediaDir()
    const parameters = [
      'main.py',
      '--port',
      this.port.toString(),
      '--preview-method',
      'auto',
      '--output-directory',
      mediaDir,
    ]

    const deviceType = this.deviceManager.getDeviceType()
    const selectedDevice = this.deviceManager.getSelectedDevice()

    // Track which backend is being started
    this.currentRunningDeviceType = deviceType

    // Add --cpu flag if running in CPU mode, otherwise add GPU-specific parameters
    if (deviceType === 'CPU') {
      this.appLogger.info('Adding --cpu flag for CPU-only mode', this.name)
      parameters.push('--cpu')
    } else {
      // Only add user-configured parameters for GPU modes
      parameters.push(...this.comfyUiParametersString.split(/\s+/).filter(Boolean))
    }

    this.appLogger.info(
      `Starting ComfyUI with backend: ${deviceType}, selected device: ${selectedDevice?.name} (${selectedDevice?.id}), python env: ${this.pythonEnvDir}`,
      this.name,
      true,
    )
    this.appLogger.info(`ComfyUI parameters: ${JSON.stringify(parameters)}`, this.name)
    this.appLogger.info(
      `ComfyUI env vars (relevant): CUDA_VISIBLE_DEVICES=${additionalEnvVariables.CUDA_VISIBLE_DEVICES ?? 'not set'}, ONEAPI_DEVICE_SELECTOR=${additionalEnvVariables.ONEAPI_DEVICE_SELECTOR ?? 'not set'}, DISABLE_IPEX=${additionalEnvVariables.DISABLE_IPEX ?? 'not set'}`,
      this.name,
    )

    const pythonBinary = this.getPythonBinaryPath()
    const apiProcess = spawn(pythonBinary, parameters, {
      cwd: this.serviceDir,
      windowsHide: true,
      env: { ...process.env, ...additionalEnvVariables },
    })

    //must be at the same tick as the spawn function call
    //otherwise we cannot really track errors given the nature of spawn() with a longlived process
    const didProcessExitEarlyTracker = new Promise<boolean>((resolve, _reject) => {
      apiProcess.on('exit', () => {
        this.appLogger.error(`encountered unexpected exit in ${this.name}.`, this.name)
        this.currentRunningDeviceType = null // Reset on exit
        resolve(true)
      })
      apiProcess.on('error', (error) => {
        this.appLogger.error(`encountered error of process in ${this.name} : ${error}`, this.name)
        this.currentRunningDeviceType = null // Reset on error
        resolve(true)
      })
    })

    return {
      process: apiProcess,
      didProcessExitEarlyTracker: didProcessExitEarlyTracker,
    }
  }
}
