import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'fs'
import * as filesystem from 'fs-extra'
import {
  LongLivedPythonApiService,
  GitService,
  installHijacks,
  patchFile,
  createEnhancedErrorDetails,
} from './service.ts'
import { aipgBaseDir, installComfyUIBackend } from './uvBasedBackends/uv.ts'
import { ProcessError } from './osProcessHelper.ts'
import { getMediaDir } from '../util.ts'
import { levelZeroDeviceSelectorEnv, cudaDeviceSelectorEnv } from './deviceDetection.ts'
import { getCachedDevices, filterDevicesByType } from './globalDeviceDetection.ts'
import { BrowserWindow } from 'electron'
import { LocalSettings } from '../main.ts'
import { downloadCustomNode } from './comfyuiTools.ts'

export const COMFYUI_DEFAULT_PARAMETERS = '--lowvram --reserve-vram 6.0'

export class ComfyUiBackendService extends LongLivedPythonApiService {
  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    super(name, port, win, settings)

    this.serviceIsSetUp().then(async (setUp) => {
      this.isSetUp = setUp
      if (this.isSetUp) {
        await this.updateCachedVersion()
        this.setStatus('notYetStarted')
      }
      this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)
    })
  }
  readonly isRequired = false
  readonly serviceFolder = 'ComfyUI'
  readonly baseDir = path.resolve(aipgBaseDir)
  readonly serviceDir = path.resolve(path.join(this.baseDir, this.serviceFolder))
  readonly pythonEnvDirCpu = path.resolve(path.join(this.serviceDir, '.venv-cpu'))
  readonly pythonEnvDirXpu = path.resolve(path.join(this.serviceDir, '.venv-xpu'))
  readonly pythonEnvDirCuda = path.resolve(path.join(this.serviceDir, '.venv-cuda'))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()
  healthEndpointUrl = `${this.baseUrl}/queue`

  private readonly remoteUrl = 'https://github.com/comfyanonymous/ComfyUI.git'
  private revision = 'v0.3.66'
  private environmentMismatchError: ErrorDetails | null = null

  private comfyUiParametersString: string = COMFYUI_DEFAULT_PARAMETERS

  private deviceType: 'XPU' | 'CUDA' | 'CPU' = 'CPU'
  private hasIntelArcGpu = false
  private hasNvidiaGpu = false
  private isDeviceSwitching = false

  get pythonEnvDir(): string {
    switch (this.deviceType) {
      case 'CPU': return this.pythonEnvDirCpu
      case 'CUDA': return this.pythonEnvDirCuda
      case 'XPU': return this.pythonEnvDirXpu
    }
  }

  async serviceIsSetUp(): Promise<boolean> {
    const dirsExist = filesystem.existsSync(this.serviceDir)
    this.appLogger.info(`Checking if comfyUI directories exist: ${dirsExist}`, this.name)
    if (!dirsExist) return false

    setTimeout(async () => {
      const version = await this.getCurrentVersion()
      if (version) {
        this.appLogger.info(`comfyUI version ${version} detected`, this.name)
        this.revision = version
      }
    })

    // Check if CPU venv exists (required)
    const cpuVenvExists = filesystem.existsSync(this.pythonEnvDirCpu)
    if (!cpuVenvExists) {
      this.appLogger.info(
        `CPU venv does not exist at ${this.pythonEnvDirCpu}, needs installation`,
        this.name,
      )
      return false
    }

    // Check if XPU venv exists (optional)
    if (filesystem.existsSync(this.pythonEnvDirXpu)) {
      this.hasIntelArcGpu = true
      this.appLogger.info(`XPU venv found, Intel Arc GPU support available`, this.name)
    }

    // Check if CUDA venv exists (optional)
    if (filesystem.existsSync(this.pythonEnvDirCuda)) {
      this.hasNvidiaGpu = true
      this.appLogger.info(`CUDA venv found, NVIDIA GPU support available`, this.name)
    }

    this.appLogger.info(
      `ComfyUI is set up (CPU: ${cpuVenvExists}, XPU: ${this.hasIntelArcGpu}, CUDA: ${this.hasNvidiaGpu})`,
      this.name,
    )
    return true
  }

  isSetUp = false

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.version) {
      this.revision = settings.version
      this.appLogger.info(`applied new comfyUI version ${this.revision}`, this.name)
    }
    if (typeof settings.comfyUiParameters === 'string') {
      this.comfyUiParametersString = settings.comfyUiParameters
      this.appLogger.info(
        `applied new comfyUI startup parameters: ${this.comfyUiParametersString}`,
        this.name,
      )
    }
  }

  async getCurrentVersion(): Promise<string | undefined> {
    try {
      const gitOutput = await this.git.run(['-C', this.serviceDir, 'rev-parse', 'HEAD'])
      const versionMatch = gitOutput.match(/HEAD detached at ([0-9a-f]{7,})|v(\d+\.\d+\.\d+)/)
      if (versionMatch) {
        return versionMatch[1]
      }
    } catch (e) {
      this.appLogger.error(`failed to get comfyUI version: ${e}`, this.name)
      return undefined
    }
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    if (!this.isSetUp) return undefined
    try {
      const versionFilePath = path.join(this.serviceDir, 'comfyui_version.py')
      if (filesystem.existsSync(versionFilePath)) {
        const versionFileContent = await filesystem.readFile(versionFilePath, 'utf-8')
        const versionMatch = versionFileContent.match(/__version__\s*=\s*["']([^"']+)["']/)
        if (versionMatch && versionMatch[1]) {
          const version = versionMatch[1]
          // Check if it's a version tag (v0.3.76) or git hash
          if (version.startsWith('v')) {
            return { version }
          } else {
            return { version: `v${version}` }
          }
        }
      }
    } catch (e) {
      this.appLogger.error(`failed to get installed ComfyUI version: ${e}`, this.name)
    }
    return undefined
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

    const checkServiceDir = async (): Promise<boolean> => {
      if (!filesystem.existsSync(this.serviceDir)) {
        return false
      }

      // Check if it's a valid git repo
      try {
        const version = await this.getCurrentVersion()
        if (version === this.revision) {
          this.appLogger.info('comfyUI already cloned, skipping', this.name)
          return true
        }
        this.appLogger.info(
          `ComfyUI version ${version?.[1]} does not match ${this.revision}. Removing...`,
          this.name,
        )
        throw new Error('Version mismatch')
      } catch (_e) {
        try {
          filesystem.removeSync(this.serviceDir)
        } finally {
          return false
        }
      }
    }

    const setupComfyUiBaseService = async (): Promise<void> => {
      installHijacks()
      if (await checkServiceDir()) {
        this.appLogger.info('comfyUI already cloned, skipping', this.name)
      } else {
        await this.git.run(['clone', this.remoteUrl, this.serviceDir])
        await this.git.run(['-C', this.serviceDir, 'checkout', this.revision], {}, this.serviceDir)
      }

      // Copy ComfyUI dependency files
      const comfyUIDepsDir = path.join(aipgBaseDir, 'comfyui-deps')
      const pyprojectSource = path.join(comfyUIDepsDir, 'pyproject.toml')
      const uvLockSource = path.join(comfyUIDepsDir, 'uv.lock')
      const pyprojectTarget = path.join(this.serviceDir, 'pyproject.toml')
      const uvLockTarget = path.join(this.serviceDir, 'uv.lock')

      // Copy dependency specification files
      this.appLogger.info(
        `Copying pyproject.toml from ${pyprojectSource} to ${pyprojectTarget}`,
        this.name,
      )
      await filesystem.copyFile(pyprojectSource, pyprojectTarget)

      this.appLogger.info(`Copying uv.lock from ${uvLockSource} to ${uvLockTarget}`, this.name)
      await filesystem.copyFile(uvLockSource, uvLockTarget)

      // Install dependencies with triple venv support
      this.appLogger.info('Installing ComfyUI with triple venv support', this.name)

      const globalDevices = getCachedDevices()
      const hasIntelArcGpu = globalDevices.some((d) => d.type === 'intel-arc')
      const hasNvidiaGpu = globalDevices.some((d) => d.type === 'nvidia')

      this.appLogger.info(
        `GPU detection: Intel Arc=${hasIntelArcGpu}, NVIDIA=${hasNvidiaGpu}`,
        this.name,
      )

      const results = await installComfyUIBackend(
        this.serviceDir,
        hasIntelArcGpu,
        hasNvidiaGpu,
        () => {
          this.win.webContents.send('show-toast', {
            type: 'warning',
            message:
              'UV cache corruption detected. Retrying installation without cache. This may take longer. You can manually clear the cache at %LOCALAPPDATA%/uv/cache',
          })
        },
      )

      this.hasIntelArcGpu = results.xpuInstalled
      this.hasNvidiaGpu = results.cudaInstalled
      this.appLogger.info(
        `Installation complete: CPU=${results.cpuInstalled}, XPU=${results.xpuInstalled}, CUDA=${results.cudaInstalled}`,
        this.name,
      )
    }

    const configureComfyUI = async (): Promise<void> => {
      try {
        this.appLogger.info('patching hijacks into comfyUI model_management', this.name)
        patchFile(
          path.join(this.serviceDir, 'comfy/model_management.py'),
          'from comfy.model_management import get_model',
          ['from ipex_to_cuda import ipex_init', 'ipex_init()'],
        )

        this.appLogger.info('Configuring extra model paths for comfyUI', this.name)
        const extraModelPathsYaml = path.join(this.serviceDir, 'extra_model_paths.yaml')
        const comfyUIModelsBasePath = path.resolve(this.baseDir, 'models/ComfyUI')
        const extraModelsYaml = `aipg:
  base_path: ${comfyUIModelsBasePath}
  checkpoints: checkpoints
  loras: |
    loras
    lora
  vae: vae
  text_encoders: |
    text_encoders
    clip
  clip_vision: clip_vision
  style_models: style_models
  embeddings: embeddings
  diffusers: diffusers
  vae_approx: vae_approx
  controlnet: |
    controlnet
    t2i_adapter
  gligen: gligen
  upscale_models: |
    upscale_models
    latent_upscale_models
  hypernetworks: hypernetworks
  photomaker: photomaker
  classifiers: classifiers
  model_patches: model_patches
  audio_encoders: audio_encoders
  diffusion_models: |
    diffusion_models
    unet
  insightface: insightface
  facerestore_models: facerestore_models
  nsfw_detector: nsfw_detector
  inpaint: inpaint`
        fs.promises.writeFile(extraModelPathsYaml, extraModelsYaml, {
          encoding: 'utf-8',
          flag: 'w',
        })
        this.appLogger.info(
          `Configured extra model paths for comfyUI at ${extraModelPathsYaml} as ${extraModelsYaml} `,
          this.name,
        )
      } catch (configError) {
        this.appLogger.error(
          `Failed to configure extra model paths for comfyUI: ${configError}`,
          this.name,
        )
        // Re-throw ProcessError instances to preserve enhanced error details
        if (configError instanceof ProcessError) {
          throw configError
        }
        // For other errors, wrap with context
        throw new Error(`Failed to configure extra model paths for comfyUI: ${configError}`)
      }
    }

    const installBuiltinCustomNodes = async (): Promise<void> => {
      try {
        const builtinCustomNodesDir = path.join(aipgBaseDir, 'comfyui-deps', 'custom_nodes')

        if (!filesystem.existsSync(builtinCustomNodesDir)) {
          this.appLogger.info(
            `No builtin custom nodes directory found at ${builtinCustomNodesDir}, skipping`,
            this.name,
          )
          return
        }

        this.appLogger.info(
          `Installing builtin custom nodes from ${builtinCustomNodesDir}`,
          this.name,
        )

        const targetCustomNodesDir = path.join(this.serviceDir, 'custom_nodes')

        if (!filesystem.existsSync(targetCustomNodesDir)) {
          this.appLogger.info(
            `Creating custom_nodes directory at ${targetCustomNodesDir}`,
            this.name,
          )
          await filesystem.ensureDir(targetCustomNodesDir)
        }

        const entries = await filesystem.readdir(builtinCustomNodesDir, { withFileTypes: true })

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const sourcePath = path.join(builtinCustomNodesDir, entry.name)
            const targetPath = path.join(targetCustomNodesDir, entry.name)

            this.appLogger.info(
              `Copying builtin custom node ${entry.name} from ${sourcePath} to ${targetPath}`,
              this.name,
            )

            await filesystem.copy(sourcePath, targetPath, { overwrite: true })

            this.appLogger.info(
              `Successfully installed builtin custom node ${entry.name}`,
              this.name,
            )
          }
        }

        this.appLogger.info(`Builtin custom nodes installation complete`, this.name)
      } catch (error) {
        this.appLogger.error(`Failed to install builtin custom nodes: ${error}`, this.name)
        throw new Error(`Failed to install builtin custom nodes: ${error}`)
      }
    }

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up comfyUI environment',
      }

      await this.git.ensureInstalled()

      currentStep = 'install comfyUI'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `installing comfyUI base repo`,
      }
      await setupComfyUiBaseService()
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `installation of comfyUI base repo complete`,
      }

      currentStep = 'configure comfyUI'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `configuring comfyUI base repo`,
      }
      await configureComfyUI()
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `configured comfyUI base repo`,
      }

      currentStep = 'install builtin custom nodes'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing builtin custom nodes',
      }
      await installBuiltinCustomNodes()
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'builtin custom nodes installation complete',
      }

      currentStep = 'install comfyUI manager'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing ComfyUI Manager custom node',
      }
      try {
        const managerNode = {
          username: 'Comfy-Org',
          repoName: 'ComfyUI-Manager',
        }
        await downloadCustomNode(managerNode, this.serviceDir)
        yield {
          serviceName: this.name,
          step: currentStep,
          status: 'executing',
          debugMessage: 'ComfyUI Manager installation complete',
        }
      } catch (error) {
        // Log warning but don't fail setup
        this.appLogger.warn(
          `Failed to install ComfyUI Manager: ${error}. Continuing setup.`,
          this.name,
        )
      }

      // Device-specific requirements and extra wheels are no longer needed
      // as uv handles all dependencies through pyproject.toml and uv.lock
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'dependencies configured',
      }
      this.isSetUp = true
      await this.updateCachedVersion()
      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: `service set up completely`,
      }
    } catch (e) {
      this.appLogger.warn(`Set up of service failed due to ${e}`, this.name, true)
      this.appLogger.warn(`Aborting set up of ${this.name} service environment`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup comfyUI service due to ${e}`,
        errorDetails,
      }
    }
  }

  getEnvVars() {
    const selectedDevice = this.devices.find((d) => d.selected)
    const baseEnv = {
      PATH: `${path.join(this.pythonEnvDir, 'Library', 'bin')};${path.join(this.git.dir, 'cmd')};${process.env.PATH}`,
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

    const [deviceType] = this.determineDeviceType(selectedDevice.id)
    this.deviceType = deviceType

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

  /**
   * Determine device type based on selected device and available venvs
   * Returns tuple of [deviceType, isAvailable]
   */
  private determineDeviceType(deviceId: string): ['CPU' | 'CUDA' | 'XPU', boolean] {
    const globalDevices = getCachedDevices()
    const globalDevice = globalDevices.find((d) => d.id === deviceId)

    if (deviceId === 'cpu' || globalDevice?.type === 'cpu') {
      return ['CPU', true]
    }

    if (globalDevice?.type === 'nvidia') {
      return filesystem.existsSync(this.pythonEnvDirCuda) ? ['CUDA', true] : ['CPU', false]
    }

    if (globalDevice?.type === 'intel-arc') {
      return filesystem.existsSync(this.pythonEnvDirXpu) ? ['XPU', true] : ['CPU', false]
    }

    return ['CPU', false]
  }

  async detectDevices() {
    const globalDevices = getCachedDevices()
    const supportedDevices = filterDevicesByType(globalDevices, ['nvidia', 'intel-arc', 'cpu'])

    this.appLogger.info(
      `ComfyUI detected ${supportedDevices.length} supported devices: ${JSON.stringify(supportedDevices, null, 2)}`,
      this.name,
    )

    // Remember the currently selected device before recreating the devices list
    const previouslySelectedDevice = this.devices.find((d) => d.selected)
    const previousDeviceType = this.deviceType

    // Check if this is the first time detectDevices is being called (initial state has only '*' device)
    const isFirstDetection = this.devices.length === 1 && this.devices[0].id === '*'

    if (supportedDevices.length === 0) {
      this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
      this.deviceType = 'CPU'
      this.appLogger.warn('No supported devices found, using CPU only', this.name)
    } else {
      const cpuDevice = supportedDevices.find((d) => d.type === 'cpu')
      const gpuDevices = supportedDevices.filter((d) => d.type !== 'cpu')

      // Check if previously selected device is still available
      const previousStillAvailable =
        previouslySelectedDevice &&
        supportedDevices.some((d) => d.id === previouslySelectedDevice.id)

      // Determine which device should be selected
      let selectedId: string | null = null
      let selectedDeviceType: 'XPU' | 'CUDA' | 'CPU' = 'CPU'

      if (previousStillAvailable) {
        // Preserve the previous selection
        selectedId = previouslySelectedDevice.id
        selectedDeviceType = previousDeviceType
        this.appLogger.info(
          `Preserving previous device selection: ${previouslySelectedDevice.name} (${selectedDeviceType})`,
          this.name,
        )
      } else if (isFirstDetection) {
        // First time detection: default to CPU to avoid unexpected GPU usage
        // User can explicitly select GPU if they want
        if (cpuDevice) {
          selectedId = cpuDevice.id
          selectedDeviceType = 'CPU'
          this.appLogger.info('First device detection: defaulting to CPU (GPU available but not auto-selected)', this.name)
        }
      } else {
        // Subsequent detection without previous selection: use priority order
        // Priority: CUDA > XPU > CPU (select GPU if venv is available)
        const nvidiaDevice = gpuDevices.find((d) => d.type === 'nvidia')
        const intelDevice = gpuDevices.find((d) => d.type === 'intel-arc')

        if (nvidiaDevice && filesystem.existsSync(this.pythonEnvDirCuda)) {
          selectedId = nvidiaDevice.id
          selectedDeviceType = 'CUDA'
          this.appLogger.info('Defaulting to NVIDIA CUDA device', this.name)
        } else if (intelDevice && filesystem.existsSync(this.pythonEnvDirXpu)) {
          selectedId = intelDevice.id
          selectedDeviceType = 'XPU'
          this.appLogger.info('Defaulting to Intel Arc XPU device', this.name)
        } else if (cpuDevice) {
          selectedId = cpuDevice.id
          selectedDeviceType = 'CPU'
          this.appLogger.info('Defaulting to CPU device', this.name)
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
        this.name,
      )
    }

    this.updateStatus()
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) {
      this.appLogger.warn(`Device ${deviceId} not found in available devices`, this.name)
      return
    }

    const selectedDevice = this.devices.find((d) => d.selected)
    if (selectedDevice?.id === deviceId) {
      this.appLogger.info(`Device ${deviceId} is already selected`, this.name)
      return
    }

    // Prevent concurrent device switches
    if (this.isDeviceSwitching) {
      this.appLogger.warn('Device switch already in progress, ignoring request', this.name)
      return
    }

    // Store old device type to check if restart is needed
    const oldDeviceType = this.deviceType
    const wasRunning = this.currentStatus === 'running'

    this.appLogger.info(
      `Selecting device ${deviceId} (current: ${selectedDevice?.id}, type: ${oldDeviceType}, running: ${wasRunning})`,
      this.name,
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
        this.name,
      )
    } else {
      this.appLogger.info(`Device type set to ${newDeviceType} for ${deviceName}`, this.name)
    }

    this.updateStatus()

    // If device type changed and service is running, restart it
    if (oldDeviceType !== this.deviceType && wasRunning) {
      this.isDeviceSwitching = true
      this.appLogger.info(
        `Device type changed from ${oldDeviceType} to ${this.deviceType}, restarting ComfyUI...`,
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
        this.appLogger.info(`Starting ComfyUI with ${this.deviceType} backend...`, this.name)
        await this.start()

        this.appLogger.info('ComfyUI restarted successfully with new device', this.name)
      } catch (error) {
        this.appLogger.error(`Failed to restart ComfyUI after device change: ${error}`, this.name)
        this.setStatus('failed')
      } finally {
        this.isDeviceSwitching = false
      }
    } else if (oldDeviceType !== this.deviceType && !wasRunning) {
      this.appLogger.info(
        `Device type changed to ${this.deviceType}, but service was not running. Will use new device on next start.`,
        this.name,
      )
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

    // Add --cpu flag if running in CPU mode, otherwise add GPU-specific parameters
    if (this.deviceType === 'CPU') {
      this.appLogger.info('Adding --cpu flag for CPU-only mode', this.name)
      parameters.push('--cpu')
    } else {
      // Only add user-configured parameters for GPU modes
      parameters.push(...this.comfyUiParametersString.split(/\s+/).filter(Boolean))
    }

    const selectedDevice = this.devices.find((d) => d.selected)
    this.appLogger.info(
      `Starting ComfyUI with backend: ${this.deviceType}, selected device: ${selectedDevice?.name} (${selectedDevice?.id}), python env: ${this.pythonEnvDir}`,
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
        resolve(true)
      })
      apiProcess.on('error', (error) => {
        this.appLogger.error(`encountered error of process in ${this.name} : ${error}`, this.name)
        resolve(true)
      })
    })

    return {
      process: apiProcess,
      didProcessExitEarlyTracker: didProcessExitEarlyTracker,
    }
  }
}
