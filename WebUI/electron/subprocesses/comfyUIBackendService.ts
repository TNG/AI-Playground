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
import { aipgBaseDir, checkBackendWithDetails, installBackendWithExtra } from './uvBasedBackends/uv.ts'
import { ProcessError } from './osProcessHelper.ts'
import { getMediaDir } from '../util.ts'
import { levelZeroDeviceSelectorEnv } from './deviceDetection.ts'
import { BrowserWindow } from 'electron'
import { LocalSettings } from '../main.ts'
import { downloadCustomNode } from './comfyuiTools.ts'
type Device = Omit<InferenceDevice, 'selected'>

export type ComfyUiVariant = 'xpu' | 'cuda' | 'cpu'

export const COMFYUI_DEFAULT_PARAMETERS = '--lowvram --reserve-vram 6.0'

/** The single comfyui-deps directory that holds the shared pyproject.toml with xpu/cuda/cpu extras */
const COMFYUI_DEPS_DIR = 'comfyui-deps'

export class ComfyUiBackendService extends LongLivedPythonApiService {
  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    super(name, port, win, settings)

    this.serviceIsSetUp().then(async (setUp) => {
      this.isSetUp = setUp
      if (this.isSetUp) {
        // Restore the installed variant so getEnvVars() uses the correct torch backend
        const installedVariant = this.readInstalledVariant()
        if (installedVariant !== null) {
          this.comfyUiVariant = installedVariant
          this.appLogger.info(
            `Restored comfyUI variant from marker file: ${installedVariant}`,
            this.name,
          )
        }
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
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()
  healthEndpointUrl = `${this.baseUrl}/queue`

  private readonly remoteUrl = 'https://github.com/comfyanonymous/ComfyUI.git'
  private revision = 'v0.3.66'
  private environmentMismatchError: ErrorDetails | null = null

  private comfyUiParametersString: string = COMFYUI_DEFAULT_PARAMETERS
  private comfyUiVariant: ComfyUiVariant = 'xpu'

  /** Path of the small JSON file that records which variant is currently installed */
  private readonly variantMarkerPath = path.join(this.serviceDir, 'aipg-variant.json')

  private readInstalledVariant(): ComfyUiVariant | null {
    try {
      if (!filesystem.existsSync(this.variantMarkerPath)) return null
      const raw = filesystem.readFileSync(this.variantMarkerPath, 'utf-8')
      const parsed = JSON.parse(raw) as { variant?: string }
      const v = parsed.variant
      if (v === 'xpu' || v === 'cuda' || v === 'cpu') return v
      return null
    } catch {
      return null
    }
  }

  private writeVariantMarker(variant: ComfyUiVariant): void {
    filesystem.writeFileSync(this.variantMarkerPath, JSON.stringify({ variant }), 'utf-8')
  }

  /** Override uninstall to also wipe the generated lockfile and variant marker so a fresh setup starts clean. */
  async uninstall(): Promise<void> {
    await super.uninstall()
    // Remove the generated uv.lock (it will be regenerated on reinstall for the new variant)
    // and the variant marker. Keep pyproject.toml so serviceIsSetUp can detect the git repo state.
    for (const file of ['uv.lock', 'aipg-variant.json']) {
      const filePath = path.join(this.serviceDir, file)
      if (filesystem.existsSync(filePath)) {
        try {
          await filesystem.remove(filePath)
          this.appLogger.info(`Removed ${file} from ComfyUI dir during uninstall`, this.name)
        } catch (e) {
          this.appLogger.warn(`Failed to remove ${file} during uninstall: ${e}`, this.name)
        }
      }
    }
  }

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

      // If venv exists but environment mismatch detected, set error details and still allow startup
      if (checkDetails.envMismatch) {
        this.appLogger.warn(
          `Service ${this.name} venv exists but environment doesn't match expected state. Will attempt startup but recommend reinstallation.`,
          this.name,
        )

        // Set error details recommending reinstallation
        // Include stderr from uv check which contains helpful information about what packages would be changed
        const stderrInfo = checkDetails.stderr
          ? `\n\n=== UV Check Output ===\n${checkDetails.stderr}`
          : ''
        const stdoutInfo = checkDetails.stdout
          ? `\n\n=== UV Check Details ===\n${checkDetails.stdout}`
          : ''

        this.environmentMismatchError = {
          command: 'ComfyUI environment check',
          exitCode: checkDetails.exitCode,
          stdout:
            `Virtual environment detected at: ${this.pythonEnvDir}\n` +
            `Environment check failed (exit code: ${checkDetails.exitCode})\n` +
            `Sync action: ${checkDetails.action}\n\n` +
            `The Python environment exists but doesn't match the expected configuration.\n` +
            `This may cause ComfyUI to fail during startup.\n\n` +
            `Recommendation: Reinstall ComfyUI to ensure the environment matches the expected state.${stdoutInfo}`,
          stderr: `Environment mismatch detected. The virtual environment at ${this.pythonEnvDir} exists but doesn't match the expected lockfile state.${stderrInfo}`,
          timestamp: new Date().toISOString(),
          duration: 0,
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
    if (typeof settings.comfyUiParameters === 'string') {
      this.comfyUiParametersString = settings.comfyUiParameters
      this.appLogger.info(
        `applied new comfyUI startup parameters: ${this.comfyUiParametersString}`,
        this.name,
      )
    }
    if (settings.comfyUiVariant) {
      const newVariant = settings.comfyUiVariant
      const installedVariant = this.readInstalledVariant()
      this.comfyUiVariant = newVariant
      this.appLogger.info(`applied new comfyUI variant: ${this.comfyUiVariant}`, this.name)

      // If the variant changed and ComfyUI is already installed, uninstall it so the
      // user can reinstall with the correct dependencies for the new variant.
      // A null installedVariant means no marker file exists (pre-tracking install) —
      // treat it as a mismatch so the user always gets the right variant.
      if (this.isSetUp && installedVariant !== newVariant) {
        this.appLogger.info(
          `ComfyUI variant changed from '${installedVariant ?? 'unknown'}' to '${newVariant}' — uninstalling to force reinstall`,
          this.name,
        )
        await this.uninstall()
        this.isSetUp = false
      }
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

    // Include the currently installed variant so the frontend can reflect it correctly
    const installedComfyUiVariant: ComfyUiVariant | undefined = this.isSetUp
      ? this.readInstalledVariant() ?? this.comfyUiVariant
      : undefined

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
          installedComfyUiVariant,
        }
      } else {
        // Only environment mismatch error, no startup error
        return {
          ...baseInfo,
          errorDetails: this.environmentMismatchError,
          installedComfyUiVariant,
        }
      }
    }

    return { ...baseInfo, installedComfyUiVariant }
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.appLogger.info('setting up service', this.name)
    this.setStatus('installing')

    // --- prerequisite check: ai-backend and openvino must be installed first ---
    const aiBackendVenv = path.resolve(path.join(aipgBaseDir, 'service', '.venv'))
    const openVinoVenv = path.resolve(path.join(aipgBaseDir, 'OpenVINO', '.venv'))
    const aiBackendReady = filesystem.existsSync(aiBackendVenv)
    const openVinoReady = filesystem.existsSync(openVinoVenv)

    if (!aiBackendReady || !openVinoReady) {
      const missing = [
        !aiBackendReady ? 'AI Backend' : null,
        !openVinoReady ? 'OpenVINO' : null,
      ]
        .filter(Boolean)
        .join(' and ')
      this.appLogger.warn(
        `Cannot set up ComfyUI: ${missing} must be installed first`,
        this.name,
        true,
      )
      this.setStatus('installationFailed')
      yield {
        serviceName: this.name,
        step: 'prerequisites',
        status: 'failed',
        debugMessage: `ComfyUI requires ${missing} to be installed first. Please install them before installing ComfyUI.`,
        errorDetails: {
          command: 'prerequisite check',
          exitCode: 1,
          stdout: `Required backends not installed: ${missing}`,
          stderr: '',
          timestamp: new Date().toISOString(),
          duration: 0,
        },
      }
      return
    }

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

      // Copy the shared pyproject.toml (with xpu/cuda/cpu extras) from comfyui-deps
      const comfyUIDepsDir = path.join(aipgBaseDir, COMFYUI_DEPS_DIR)
      const pyprojectSource = path.join(comfyUIDepsDir, 'pyproject.toml')
      const pyprojectTarget = path.join(this.serviceDir, 'pyproject.toml')
      this.appLogger.info(
        `Copying pyproject.toml from ${pyprojectSource} to ${pyprojectTarget}`,
        this.name,
      )
      await filesystem.copyFile(pyprojectSource, pyprojectTarget)

      // Remove any stale uv.lock so uv regenerates it for the chosen extra
      const uvLockTarget = path.join(this.serviceDir, 'uv.lock')
      if (filesystem.existsSync(uvLockTarget)) {
        await filesystem.remove(uvLockTarget)
        this.appLogger.info('Removed stale uv.lock so it will be regenerated', this.name)
      }

      // Install dependencies for the selected variant via uv sync --extra <variant>
      this.appLogger.info(
        `Installing ComfyUI dependencies for variant '${this.comfyUiVariant}' using uv sync --extra`,
        this.name,
      )
      await installBackendWithExtra(this.serviceDir, this.comfyUiVariant, () => {
        this.win.webContents.send('show-toast', {
          type: 'warning',
          message:
            'UV cache corruption detected. Retrying installation without cache. This may take longer. You can manually clear the cache at %LOCALAPPDATA%/uv/cache',
        })
      })
    }

    const configureComfyUI = async (): Promise<void> => {
      try {
        // The ipex_to_cuda hijack is only needed for the XPU variant
        if (this.comfyUiVariant === 'xpu') {
          this.appLogger.info('patching hijacks into comfyUI model_management', this.name)
          patchFile(
            path.join(this.serviceDir, 'comfy/model_management.py'),
            'from comfy.model_management import get_model',
            ['from ipex_to_cuda import ipex_init', 'ipex_init()'],
          )
        } else {
          this.appLogger.info(
            `Removing ipex_to_cuda hijack from model_management for variant '${this.comfyUiVariant}'`,
            this.name,
          )
          const modelMgmtPath = path.join(this.serviceDir, 'comfy/model_management.py')
          if (filesystem.existsSync(modelMgmtPath)) {
            let content = filesystem.readFileSync(modelMgmtPath, 'utf-8')
            // Remove the ipex_to_cuda lines that may have been injected by a previous XPU install
            content = content
              .replace(/^from ipex_to_cuda import ipex_init\r?\n/m, '')
              .replace(/^ipex_init\(\)\r?\n/m, '')
            filesystem.writeFileSync(modelMgmtPath, content, 'utf-8')
            this.appLogger.info('Removed ipex_to_cuda lines from model_management.py', this.name)
          }
        }

        this.appLogger.info('Configuring extra model paths for comfyUI', this.name)
        const extraModelPathsYaml = path.join(this.serviceDir, 'extra_model_paths.yaml')
        const comfyUIModelsPath = path.join('..', 'models/ComfyUI')
        const extraModelsYaml = `aipg:
  base_path: ${comfyUIModelsPath}
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
      this.writeVariantMarker(this.comfyUiVariant)
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
    const torchBackend =
      process.platform === 'win32'
        ? this.comfyUiVariant === 'cuda'
          ? 'cuda'
          : this.comfyUiVariant === 'cpu'
            ? 'cpu'
            : 'xpu'
        : undefined
    const isXpu = this.comfyUiVariant === 'xpu'
    return {
      PATH: `${path.join(this.pythonEnvDir, 'Library', 'bin')};${path.join(this.git.dir, 'cmd')};${process.env.PATH}`,
      PYTHONNOUSERSITE: 'true',
      // Intel SYCL vars only needed for XPU variant
      ...(isXpu ? { SYCL_ENABLE_DEFAULT_CONTEXTS: '1', SYCL_CACHE_PERSISTENT: '1' } : {}),
      PYTHONIOENCODING: 'utf-8',
      HF_ENDPOINT: this.settings.huggingfaceEndpoint,
      // ONEAPI_DEVICE_SELECTOR only relevant for XPU
      ...(isXpu ? levelZeroDeviceSelectorEnv(this.devices.find((d) => d.selected)?.id) : {}),
      PIP_CONFIG_FILE: 'nul',
      UV_NO_CONFIG: '1',
      UV_TORCH_BACKEND: torchBackend,
    }
  }

  getPythonBinaryPath() {
    return path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
  }

  async detectDevices() {
    // For non-XPU variants the installed torch doesn't have XPU support,
    // so skip the XPU detection script entirely.
    if (this.comfyUiVariant !== 'xpu') {
      this.appLogger.info(
        `Skipping XPU device detection for variant '${this.comfyUiVariant}'`,
        this.name,
      )
      this.devices = [{ id: '*', name: 'Auto select device', selected: true }]
      this.updateStatus()
      return
    }

    // For now, use auto-select device similar to aiBackendService
    const availableDevices = [{ id: '*', name: 'Auto select device', selected: true }]
    let allDevices: Device[] = []
    try {
      const pythonScript = `
import torch
import sys

try:
    # Try to get the number of XPU devices
    device_count = torch.xpu.device_count()

    # For each device, get its name and print it
    for i in range(device_count):
        try:
            device_name = torch.xpu.get_device_name(i)
            print(f"{i}|{device_name}")
        except Exception as e:
            print(f"{i}|Unknown Device")
except Exception as e:
    print(f"Error detecting XPU devices: {str(e)}")
    sys.exit(1)
`
      let i = 0
      let lastDeviceList: Device[] = []
      const pythonBinary = this.getPythonBinaryPath()
      while ((lastDeviceList.length > 0 || i == 0) && i < 10) {
        const env = { ...this.getEnvVars(), ONEAPI_DEVICE_SELECTOR: `level_zero:${i}` }
        this.appLogger.info(
          `Detecting level_zero devices with ONEAPI_DEVICE_SELECTOR=${env.ONEAPI_DEVICE_SELECTOR}`,
          this.name,
        )
        const result = await spawnProcessAsync(
          pythonBinary,
          ['-c', pythonScript],
          (d) => this.appLogger.info(d, this.name),
          env,
        )
        this.appLogger.info(`Device detection result: ${result}`, this.name)

        // Parse the output
        const devices: Device[] = []
        const lines = result
          .split('\n')
          .map((l) => l.trim())
          .filter((line) => line !== '')

        for (const line of lines) {
          if (line.startsWith('Error detecting XPU devices:')) {
            console.error(line)
            continue
          }

          const parts = line.split('|', 2)
          if (parts.length == 2) {
            const id = `${i}`
            const name = parts[1]

            devices.push({ id, name })
          }
        }
        i = i + 1
        lastDeviceList = devices
        allDevices = allDevices.concat(lastDeviceList)
      }
    } catch (error) {
      console.error('Error detecting level_zero devices:', error)
    }
    this.appLogger.info(`detected devices: ${JSON.stringify(allDevices, null, 2)}`, this.name)
    this.devices =
      allDevices.length > 0 ? allDevices.map((d) => ({ ...d, selected: false })) : availableDevices
    this.updateStatus()
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    // For non-XPU variants, ensure the ipex_to_cuda patch is not present in
    // model_management.py — it may have been left over from a previous XPU install.
    if (this.comfyUiVariant !== 'xpu') {
      const modelMgmtPath = path.join(this.serviceDir, 'comfy/model_management.py')
      if (filesystem.existsSync(modelMgmtPath)) {
        const original = filesystem.readFileSync(modelMgmtPath, 'utf-8')
        const patched = original
          .replace(/^from ipex_to_cuda import ipex_init\r?\n/m, '')
          .replace(/^ipex_init\(\)\r?\n/m, '')
        if (patched !== original) {
          filesystem.writeFileSync(modelMgmtPath, patched, 'utf-8')
          this.appLogger.info(
            'Removed ipex_to_cuda lines from model_management.py before startup',
            this.name,
          )
        }
      }
    }

    const additionalEnvVariables = this.getEnvVars()
    const mediaDir = getMediaDir()
    const userParams = this.comfyUiParametersString.split(/\s+/).filter(Boolean)
    // For the cpu variant, always pass --cpu so ComfyUI doesn't attempt CUDA/XPU
    // even when the installed torch package is the XPU build (e.g. fallback deps).
    // Remove VRAM flags that are incompatible with --cpu.
    if (this.comfyUiVariant === 'cpu') {
      const vramFlags = ['--lowvram', '--normalvram', '--highvram', '--novram', '--gpu-only']
      for (const flag of vramFlags) {
        const idx = userParams.indexOf(flag)
        if (idx !== -1) {
          userParams.splice(idx, 1)
          this.appLogger.info(`Removed '${flag}' from parameters (incompatible with --cpu)`, this.name)
        }
      }
      if (!userParams.includes('--cpu')) {
        userParams.push('--cpu')
      }
    }
    const parameters = [
      'main.py',
      '--port',
      this.port.toString(),
      '--preview-method',
      'auto',
      '--output-directory',
      mediaDir,
      ...userParams,
    ]
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

