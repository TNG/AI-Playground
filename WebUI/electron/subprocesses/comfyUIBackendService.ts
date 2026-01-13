import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'fs'
import * as filesystem from 'fs-extra'

import { spawnProcessAsync } from './osProcessHelper.ts'
import {
  LongLivedPythonApiService,
  GitService,
  installHijacks,
  patchFile,
  createEnhancedErrorDetails,
} from './service.ts'
import {
  aipgBaseDir,
  checkBackend,
  checkBackendWithDetails,
  installBackend,
} from './uvBasedBackends/uv.ts'
import { ProcessError } from './osProcessHelper.ts'
import { getMediaDir } from '../util.ts'
import { levelZeroDeviceSelectorEnv, cudaDeviceSelectorEnv } from './deviceDetection.ts'
import { BrowserWindow } from 'electron'
import { LocalSettings } from '../main.ts'
import { downloadCustomNode } from './comfyuiTools.ts'
import {
  TORCH_DEVICE_DETECTION_SCRIPT,
  parseDeviceDetectionOutput,
  prioritizeDevices,
} from './deviceUtils.ts'
import { detectNvidiaGpus, isNvidiaDevice } from './deviceNvidia.ts'
import { isIntelDevice } from './deviceArch.ts'
type Device = Omit<InferenceDevice, 'selected'>
export class ComfyUiBackendService extends LongLivedPythonApiService {
  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    super(name, port, win, settings)

    this.serviceIsSetUp().then(async (setUp) => {
      this.isSetUp = setUp
      if (this.isSetUp) {
        await this.updateCachedVersion()
        await this.detectDevices()
        this.setStatus('notYetStarted')
      }
      this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)
    })
  }
  readonly isRequired = false
  readonly serviceFolder = 'ComfyUI'
  readonly baseDir = path.resolve(aipgBaseDir)
  readonly serviceDir = path.resolve(path.join(this.baseDir, this.serviceFolder))
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  private deviceType: 'CUDA' | 'XPU' | 'CPU' = 'XPU' // Track detected device type
  readonly git = new GitService()
  healthEndpointUrl = `${this.baseUrl}/queue`

  private readonly remoteUrl = 'https://github.com/comfyanonymous/ComfyUI.git'
  private revision = 'v0.3.66'
  private environmentMismatchError: ErrorDetails | null = null

  private readonly comfyUIStartupParameters =
    process.platform !== 'win32'
      ? []
      : this.settings.comfyUiParameters
        ? this.settings.comfyUiParameters
        : ['--lowvram', '--disable-ipex-optimize', '--bf16-unet', '--reserve-vram', '6.0']

  async serviceIsSetUp(): Promise<boolean> {
    this.appLogger.info(`Checking if comfyUI directories exist`, this.name)
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

    // For ComfyUI, only check if venv exists, not exact lockfile match
    try {
      const checkDetails = await checkBackendWithDetails(this.serviceFolder, this.pythonEnvDir)

      // If venv doesn't exist, service is not set up
      if (!checkDetails.venvExists) {
        this.appLogger.info(
          `Service ${this.name} venv does not exist, needs installation`,
          this.name,
        )
        return false
      }

      // If venv exists but environment mismatch detected, automatically fix it
      if (checkDetails.envMismatch) {
        this.appLogger.warn(
          `Service ${this.name} venv exists but environment doesn't match expected state. Automatically syncing environment...`,
          this.name,
        )

        try {
          // Automatically run uv sync to fix the environment
          this.appLogger.info(`Running uv sync to update ComfyUI environment`, this.name)
          await installBackend(this.serviceFolder, () => {
            this.win.webContents.send('show-toast', {
              type: 'info',
              message:
                'ComfyUI environment is being updated to match expected configuration. This may take a moment...',
            })
          })

          this.appLogger.info(
            `Successfully synced ComfyUI environment to match lockfile`,
            this.name,
          )

          // Clear any previous environment mismatch error
          this.environmentMismatchError = null
        } catch (syncError) {
          // If sync fails, set error details
          this.appLogger.error(`Failed to sync ComfyUI environment: ${syncError}`, this.name)

          const stderrInfo = checkDetails.stderr
            ? `\n\n=== UV Check Output ===\n${checkDetails.stderr}`
            : ''
          const stdoutInfo = checkDetails.stdout
            ? `\n\n=== UV Check Details ===\n${checkDetails.stdout}`
            : ''

          this.environmentMismatchError = {
            command: 'ComfyUI environment sync',
            exitCode: checkDetails.exitCode,
            stdout:
              `Virtual environment detected at: ${this.pythonEnvDir}\n` +
              `Environment check failed (exit code: ${checkDetails.exitCode})\n` +
              `Sync action: ${checkDetails.action}\n\n` +
              `The Python environment exists but doesn't match the expected configuration.\n` +
              `Attempted to automatically sync but failed: ${syncError}\n\n` +
              `Recommendation: Reinstall ComfyUI to ensure the environment matches the expected state.${stdoutInfo}`,
            stderr: `Environment mismatch detected and sync failed. The virtual environment at ${this.pythonEnvDir} exists but doesn't match the expected lockfile state.${stderrInfo}\n\nSync error: ${syncError}`,
            timestamp: new Date().toISOString(),
            duration: 0,
          }

          this.win.webContents.send('show-toast', {
            type: 'error',
            message:
              'Failed to automatically update ComfyUI environment. Please try reinstalling ComfyUI.',
          })
        }
      } else {
        // Clear environment mismatch error if environment is in sync
        this.environmentMismatchError = null
      }

      // Venv exists, allow startup attempt (even if mismatch detected)
      this.appLogger.info(`Service ${this.name} venv exists, allowing startup attempt`, this.name)
      return true
    } catch (error) {
      // If check fails completely, assume not set up
      this.appLogger.error(`Failed to check ${this.name} environment: ${error}`, this.name)
      return false
    }
  }

  isSetUp = false

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.version) {
      this.revision = settings.version
      this.appLogger.info(`applied new comfyUI version ${this.revision}`, this.name)
    }
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) return
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))

    // Update deviceType based on selected device
    const selectedDevice = this.devices.find((d) => d.selected)
    if (selectedDevice?.id === 'cpu') {
      this.deviceType = 'CPU'
      this.appLogger.info('Device changed to CPU', this.name)
    } else if (selectedDevice) {
      // Check the selected device's name to determine device type

      if (isNvidiaDevice(selectedDevice.name)) {
        this.deviceType = 'CUDA'
      } else if (isIntelDevice(selectedDevice.name)) {
        this.deviceType = 'XPU'
      } else {
        this.deviceType = 'XPU' // Default to XPU for unknown devices
      }

      this.appLogger.info(
        `Device changed to ${selectedDevice.name} (${this.deviceType})`,
        this.name,
      )
    }

    this.updateStatus()
  }

  async getSettings(): Promise<ServiceSettings> {
    this.appLogger.info(`getting comfyUI settings`, this.name)
    return { version: this.revision, serviceName: 'comfyui-backend' }
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

      // Copy ComfyUI dependency files and install using bundled uv
      const comfyUIDepsDir = path.join(aipgBaseDir, 'comfyui-deps')
      const pyprojectSource = path.join(comfyUIDepsDir, 'pyproject.toml')
      const uvLockSource = path.join(comfyUIDepsDir, 'uv.lock')
      const pyprojectTarget = path.join(this.serviceDir, 'pyproject.toml')
      const uvLockTarget = path.join(this.serviceDir, 'uv.lock')

      // Check if dependencies are already installed
      let needsInstall = false
      const venvDir = path.join(this.serviceDir, '.venv')

      // First check if venv directory exists
      if (!filesystem.existsSync(venvDir)) {
        this.appLogger.info('ComfyUI venv does not exist, installation needed', this.name)
        needsInstall = true
      } else {
        // Venv exists, now check if dependencies match lockfile
        try {
          await checkBackend(this.serviceFolder)
          this.appLogger.info('ComfyUI dependencies already installed, skipping', this.name)
        } catch (_checkError) {
          this.appLogger.info('ComfyUI dependencies out of sync, reinstallation needed', this.name)
          needsInstall = true
        }
      }

      if (needsInstall) {
        // Detect GPU type before installation to install correct PyTorch variant
        let detectedGpuType: 'cuda' | 'xpu' | 'cpu' = 'xpu' // Default to xpu for backward compatibility

        // Try to detect NVIDIA GPU using shared detection
        this.appLogger.info('Detecting GPU type before PyTorch installation', this.name)
        const nvidiaDevices = await detectNvidiaGpus(this.name)

        if (nvidiaDevices.length > 0) {
          detectedGpuType = 'cuda'
          this.appLogger.info(
            `Detected NVIDIA GPU - will install PyTorch with CUDA support`,
            this.name,
          )
        } else {
          this.appLogger.info(`No NVIDIA GPU detected, checking for Intel XPU`, this.name)
          // If no NVIDIA GPU, assume XPU (Intel) - this is the default
        }

        // Copy dependency specification files
        this.appLogger.info(
          `Copying pyproject.toml from ${pyprojectSource} to ${pyprojectTarget}`,
          this.name,
        )
        await filesystem.copyFile(pyprojectSource, pyprojectTarget)

        // If CUDA GPU detected, modify pyproject.toml to use CUDA torch backend
        if (detectedGpuType === 'cuda') {
          this.appLogger.info('Modifying pyproject.toml to use CUDA torch backend', this.name)
          let pyprojectContent = await filesystem.readFile(pyprojectTarget, 'utf-8')

          // Replace torch-backend from xpu to cuda
          pyprojectContent = pyprojectContent.replace(
            /torch-backend\s*=\s*"xpu"/,
            'torch-backend = "cuda"',
          )

          // Replace torch source index from pytorch-xpu to pytorch-cuda
          pyprojectContent = pyprojectContent.replace(
            /\{ index = "pytorch-xpu", marker = "sys_platform == 'win32'" \}/g,
            '{ index = "pytorch-cuda", marker = "sys_platform == \'win32\'" }',
          )

          // Update PyTorch version requirement to match available CUDA builds
          // The pytorch-cuda index has torch up to 2.6.0, not 2.10.0
          // Handle both quoted and unquoted versions, with possible whitespace
          pyprojectContent = pyprojectContent.replace(/"torch>=2\.\d+\.\d+"/g, '"torch>=2.5.0"')
          pyprojectContent = pyprojectContent.replace(/torch>=2\.\d+\.\d+/g, 'torch>=2.5.0')

          await filesystem.writeFile(pyprojectTarget, pyprojectContent, 'utf-8')
          this.appLogger.info('Updated pyproject.toml for CUDA support', this.name)
        }

        // Remove old lockfile as it's for XPU and won't work with CUDA
        if (detectedGpuType === 'cuda') {
          this.appLogger.info(
            'Skipping uv.lock copy for CUDA - will generate new lockfile',
            this.name,
          )
          // Don't copy the XPU lockfile, let UV generate a new one for CUDA
        } else {
          this.appLogger.info(`Copying uv.lock from ${uvLockSource} to ${uvLockTarget}`, this.name)
          await filesystem.copyFile(uvLockSource, uvLockTarget)
        }

        // Install dependencies
        this.appLogger.info(
          `Installing ComfyUI dependencies with ${detectedGpuType} torch backend`,
          this.name,
        )
        await installBackend(this.serviceFolder, () => {
          this.win.webContents.send('show-toast', {
            type: 'warning',
            message:
              'Dependency compatibility issue detected. Regenerating lockfile with updated package versions. This may take longer.',
          })
        })
      }
    }

    const configureComfyUI = async (): Promise<void> => {
      try {
        this.appLogger.info('patching hijacks into comfyUI model_management', this.name)
        patchFile(
          path.join(this.serviceDir, 'comfy/model_management.py'),
          'from comfy.model_management import get_model',
          [
            'import os',
            'if os.environ.get("DISABLE_IPEX", "").lower() not in ("1", "true", "yes"):',
            '    from ipex_to_cuda import ipex_init',
            '    ipex_init()',
          ],
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

    this.appLogger.info(
      `getEnvVars called - deviceType: ${this.deviceType}, selectedDevice: ${selectedDevice?.name} (id: ${selectedDevice?.id})`,
      this.name,
    )

    // Base environment variables
    const baseEnv = {
      PATH: `${path.join(this.pythonEnvDir, 'Library', 'bin')};${path.join(this.git.dir, 'cmd')};${process.env.PATH}`,
      PYTHONNOUSERSITE: 'true',
      PYTHONIOENCODING: 'utf-8',
      HF_ENDPOINT: this.settings.huggingfaceEndpoint,
      PIP_CONFIG_FILE: 'nul',
      UV_NO_CONFIG: '1',
    }

    // Check if CPU is explicitly selected
    if (selectedDevice?.id === 'cpu') {
      this.deviceType = 'CPU'
      this.appLogger.info('Using CPU mode for ComfyUI (explicitly selected)', this.name)
      // Explicitly hide all GPU devices and disable IPEX to ensure PyTorch uses CPU only
      return {
        ...baseEnv,
        CUDA_VISIBLE_DEVICES: '',
        ONEAPI_DEVICE_SELECTOR: '',
        DISABLE_IPEX: '1', // Disable Intel Extension for PyTorch
      }
    }

    // Device-specific environment variables for GPU modes
    let deviceEnv = {}
    let torchBackend: string | undefined = undefined

    // Extract actual device ID by removing vendor prefix (nvidia-, intel-, etc.)
    const actualDeviceId = selectedDevice?.id?.replace(/^(nvidia|intel)-/, '') || '0'

    this.appLogger.info(
      `Setting up GPU environment - deviceType: ${this.deviceType}, actualDeviceId: ${actualDeviceId}`,
      this.name,
    )

    if (this.deviceType === 'CUDA') {
      // CUDA/NVIDIA GPU configuration
      deviceEnv = cudaDeviceSelectorEnv(actualDeviceId)
      torchBackend = 'cuda'
      this.appLogger.info(`Using CUDA with device ${actualDeviceId}`, this.name)
    } else if (this.deviceType === 'XPU') {
      // Intel XPU configuration
      deviceEnv = {
        ...levelZeroDeviceSelectorEnv(actualDeviceId),
        SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
        SYCL_CACHE_PERSISTENT: '1',
      }
      torchBackend = process.platform === 'win32' ? 'xpu' : undefined
      this.appLogger.info(`Using XPU with device ${actualDeviceId}`, this.name)
    }

    const finalEnv = {
      ...baseEnv,
      ...deviceEnv,
      ...(torchBackend && { UV_TORCH_BACKEND: torchBackend }),
    }

    this.appLogger.info(
      `Final environment variables: ${JSON.stringify({ ...deviceEnv, UV_TORCH_BACKEND: torchBackend }, null, 2)}`,
      this.name,
    )

    return finalEnv
  }

  getPythonBinaryPath() {
    return path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
  }

  async detectDevices() {
    this.appLogger.info('Starting device detection for all GPU types', this.name)

    const allDevices: Device[] = []

    try {
      // Detect NVIDIA GPUs
      this.appLogger.info('Detecting NVIDIA GPUs for CUDA support', this.name)
      const nvidiaDevices = await detectNvidiaGpus(this.name)
      if (nvidiaDevices.length > 0) {
        // Prefix NVIDIA device IDs to avoid conflicts
        const prefixedNvidiaDevices = nvidiaDevices.map((d) => ({
          ...d,
          id: `nvidia-${d.id}`,
        }))
        allDevices.push(...prefixedNvidiaDevices)
        this.appLogger.info(`Detected ${nvidiaDevices.length} NVIDIA GPU(s)`, this.name)
      }

      // Detect Intel XPU devices (only if Python environment is set up)
      const pythonBinary = this.getPythonBinaryPath()
      if (filesystem.existsSync(pythonBinary)) {
        try {
          this.appLogger.info('Detecting Intel XPU devices', this.name)

          const cleanEnv = {
            PATH: `${path.join(this.pythonEnvDir, 'Library', 'bin')};${path.join(this.git.dir, 'cmd')};${process.env.PATH}`,
            PYTHONNOUSERSITE: 'true',
            PYTHONIOENCODING: 'utf-8',
            HF_ENDPOINT: this.settings.huggingfaceEndpoint,
            PIP_CONFIG_FILE: 'nul',
            UV_NO_CONFIG: '1',
          }

          // Quick check to see if torch is importable
          const checkScript = 'import torch; import sys; sys.exit(0)'
          await spawnProcessAsync(
            pythonBinary,
            ['-c', checkScript],
            (d) => this.appLogger.info(d, this.name),
            cleanEnv,
          )

          // Run detection for XPU
          const result = await spawnProcessAsync(
            pythonBinary,
            ['-c', TORCH_DEVICE_DETECTION_SCRIPT],
            (d) => this.appLogger.info(d, this.name),
            cleanEnv,
          )

          const parsed = parseDeviceDetectionOutput(result, this.name)

          // For XPU devices, iterate through multiple device selectors
          if (parsed.deviceType === 'XPU') {
            let xpuDevices: Device[] = []
            let i = 0
            let lastDeviceList: Device[] = []

            while ((lastDeviceList.length > 0 || i == 0) && i < 10) {
              const env = { ...cleanEnv, ONEAPI_DEVICE_SELECTOR: `level_zero:${i}` }
              const xpuResult = await spawnProcessAsync(
                pythonBinary,
                ['-c', TORCH_DEVICE_DETECTION_SCRIPT],
                (d) => this.appLogger.info(d, this.name),
                env,
              )

              const xpuParsed = parseDeviceDetectionOutput(xpuResult, this.name)
              const devices = xpuParsed.devices.map((d) => ({ id: `${i}`, name: d.name }))

              i = i + 1
              lastDeviceList = devices
              xpuDevices = xpuDevices.concat(lastDeviceList)
            }

            if (xpuDevices.length > 0) {
              allDevices.push(...xpuDevices)
              this.appLogger.info(`Detected ${xpuDevices.length} Intel XPU device(s)`, this.name)
            }
          }
        } catch (error) {
          this.appLogger.info(
            `Python environment not available for Intel XPU detection: ${error}`,
            this.name,
          )
        }
      } else {
        this.appLogger.info(
          'ComfyUI Python environment not set up yet, skipping Intel XPU detection',
          this.name,
        )
      }

      // Build final device list: all detected GPUs + CPU option
      if (allDevices.length === 0) {
        // No GPUs detected, CPU is the only option and default
        this.deviceType = 'CPU'
        this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
        this.appLogger.info('No GPUs detected, CPU will be used', this.name)
      } else {
        // GPUs detected - prioritize: Intel (dedicated) > Intel (integrated) > NVIDIA > Other > CPU
        const allDevicesWithCpu = [...allDevices, { id: 'cpu', name: 'CPU' }]
        this.devices = prioritizeDevices(allDevicesWithCpu, this.name)

        // Set initial device type based on selected (first priority) GPU
        const selectedDevice = this.devices.find((d) => d.selected)
        if (selectedDevice && selectedDevice.id !== 'cpu') {
          if (isNvidiaDevice(selectedDevice.name)) {
            this.deviceType = 'CUDA'
          } else if (isIntelDevice(selectedDevice.name)) {
            this.deviceType = 'XPU'
          }
        }

        this.appLogger.info(
          `Detected ${allDevices.length} GPU(s), default device: ${selectedDevice?.name} (type: ${this.deviceType})`,
          this.name,
        )
      }
    } catch (error) {
      this.appLogger.error(`Error detecting devices: ${error}`, this.name)
      // Fallback to CPU on error
      this.deviceType = 'CPU'
      this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
    }

    this.appLogger.info(
      `Device detection complete. Available devices: ${JSON.stringify(
        this.devices.map((d) => d.name),
        null,
        2,
      )}`,
      this.name,
    )

    this.updateStatus()
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const additionalEnvVariables = this.getEnvVars()
    const mediaDir = getMediaDir()

    // Build parameters array, adding --cpu flag if CPU mode is selected
    const parameters = [
      'main.py',
      '--port',
      this.port.toString(),
      '--preview-method',
      'auto',
      '--output-directory',
      mediaDir,
    ]

    // Add --cpu flag if running in CPU mode
    if (this.deviceType === 'CPU') {
      this.appLogger.info('Adding --cpu flag for CPU-only mode', this.name)
      parameters.push('--cpu')
      // For CPU mode, don't add GPU-specific optimization flags
    } else {
      // Add user-configured or default startup parameters (only for GPU modes)
      parameters.push(...this.comfyUIStartupParameters)
    }

    this.appLogger.info(
      `starting comfyui with ${JSON.stringify({ parameters, additionalEnvVariables })}`,
      this.name,
      true,
    )
    const pythonBinary = this.getPythonBinaryPath()
    const apiProcess = spawn(pythonBinary, parameters, {
      cwd: this.serviceDir,
      windowsHide: true,
      env: Object.assign(process.env, additionalEnvVariables),
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
