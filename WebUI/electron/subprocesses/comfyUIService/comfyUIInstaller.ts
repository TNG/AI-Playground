import path from 'node:path'
import os from 'node:os'
import fs from 'fs'
import * as filesystem from 'fs-extra'
import { AppLogger } from '../../logging/logger.ts'
import { ComfyUIPaths, ComfyUIDeviceType, ComfyUIVersion } from './comfyUITypes.ts'
import { GitService, installHijacks, patchFile, createEnhancedErrorDetails } from '../service.ts'
import { aipgBaseDir, installComfyUISingleBackend } from '../uvBasedBackends/uv.ts'
import { ProcessError } from '../osProcessHelper.ts'
import { getCachedDevices } from '../globalDeviceDetection.ts'
import { BrowserWindow } from 'electron'

/** Name of the marker file that records which backend type is installed in the venv */
const BACKEND_TYPE_MARKER = '.venv-backend-type'

/**
 * Handles installation, setup, and version management for ComfyUI.
 * Only a single Python venv (`.venv`) is ever present; it is replaced when the
 * required device type changes.
 */
export class ComfyUIInstaller {
  private readonly paths: ComfyUIPaths
  private readonly appLogger: AppLogger
  private readonly serviceName: BackendServiceName
  private readonly git = new GitService()
  private readonly win: BrowserWindow
  private revision = 'v0.3.66'

  private readonly remoteUrl = 'https://github.com/comfyanonymous/ComfyUI.git'

  hasIntelArcGpu = false
  hasNvidiaGpu = false

  constructor(
    paths: ComfyUIPaths,
    appLogger: AppLogger,
    serviceName: BackendServiceName,
    win: BrowserWindow,
    revision: string,
  ) {
    this.paths = paths
    this.appLogger = appLogger
    this.serviceName = serviceName
    this.win = win
    this.revision = revision
  }

  /** Get git directory path */
  getGitDir(): string {
    return this.git.dir
  }

  /**
   * Return the device type that should be installed based on detected hardware.
   * Priority: CUDA > XPU > CPU
   */
  getRequiredDeviceType(): ComfyUIDeviceType {
    const globalDevices = getCachedDevices()
    const hasIntelArc = globalDevices.some((d) => d.type === 'intel-arc')
    const hasNvidia = globalDevices.some((d) => d.type === 'nvidia')
    if (hasNvidia) return 'CUDA'
    if (hasIntelArc) return 'XPU'
    return 'CPU'
  }

  /** Read the backend type that was recorded in the venv marker file, or undefined */
  private readInstalledBackendType(): ComfyUIDeviceType | undefined {
    const markerPath = path.join(this.paths.serviceDir, BACKEND_TYPE_MARKER)
    if (!filesystem.existsSync(markerPath)) return undefined
    const raw = filesystem.readFileSync(markerPath, 'utf-8').trim() as ComfyUIDeviceType
    return raw === 'CPU' || raw === 'XPU' || raw === 'CUDA' ? raw : undefined
  }

  /** Write the installed backend type to the marker file */
  private writeInstalledBackendType(type: ComfyUIDeviceType): void {
    const markerPath = path.join(this.paths.serviceDir, BACKEND_TYPE_MARKER)
    filesystem.writeFileSync(markerPath, type, 'utf-8')
  }

  /**
   * Check if ComfyUI is set up AND the installed backend matches the required device type.
   * Also updates `hasIntelArcGpu` / `hasNvidiaGpu` based on detected hardware.
   */
  async serviceIsSetUp(): Promise<boolean> {
    const globalDevices = getCachedDevices()
    this.hasIntelArcGpu = globalDevices.some((d) => d.type === 'intel-arc')
    this.hasNvidiaGpu = globalDevices.some((d) => d.type === 'nvidia')

    const dirsExist = filesystem.existsSync(this.paths.serviceDir)
    this.appLogger.info(`Checking if comfyUI directories exist: ${dirsExist}`, this.serviceName)
    if (!dirsExist) return false

    await this.initComfyUIVersion()

    const venvExists = filesystem.existsSync(this.paths.pythonEnvDir)
    if (!venvExists) {
      this.appLogger.info(
        `Venv does not exist at ${this.paths.pythonEnvDir}, needs installation`,
        this.serviceName,
      )
      return false
    }

    const installedType = this.readInstalledBackendType()
    const requiredType = this.getRequiredDeviceType()

    this.appLogger.info(
      `ComfyUI venv found. Installed backend: ${installedType ?? 'unknown'}, required: ${requiredType}`,
      this.serviceName,
    )

    if (installedType !== requiredType) {
      this.appLogger.info(
        `Backend mismatch (installed: ${installedType}, required: ${requiredType}) — will reinstall`,
        this.serviceName,
      )
      return false
    }

    return true
  }

  /** Initialize the revision from the currently checked-out git version */
  async initComfyUIVersion(): Promise<void> {
    try {
      const version = await this.getCurrentVersion()
      if (version) {
        this.appLogger.info(`comfyUI version ${version} detected`, this.serviceName)
        this.revision = version
      }
    } catch (e) {
      this.appLogger.error(`Failed to initialize comfyUI version: ${e}`, this.serviceName)
    }
  }

  /** Update the version to install */
  updateVersion(version: string): void {
    this.revision = version
    this.appLogger.info(`applied new comfyUI version ${this.revision}`, this.serviceName)
  }

  /** Get the current git version */
  async getCurrentVersion(): Promise<string | undefined> {
    try {
      const branchOutput = await this.git.run([
        '-C',
        this.paths.serviceDir,
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ])
      const branchName = branchOutput.trim()
      if (branchName !== 'HEAD') return branchName

      try {
        const tagOutput = await this.git.run([
          '-C',
          this.paths.serviceDir,
          'describe',
          '--tags',
          '--exact-match',
        ])
        return tagOutput.trim()
      } catch {
        const hashOutput = await this.git.run([
          '-C',
          this.paths.serviceDir,
          'rev-parse',
          '--short',
          'HEAD',
        ])
        return hashOutput.trim()
      }
    } catch (e) {
      this.appLogger.error(`failed to get comfyUI version: ${e}`, this.serviceName)
      return undefined
    }
  }

  /** Get the currently installed version */
  async getInstalledVersion(): Promise<ComfyUIVersion | undefined> {
    if (!(await this.serviceIsSetUp())) return undefined
    try {
      const versionFilePath = path.join(this.paths.serviceDir, 'comfyui_version.py')
      if (filesystem.existsSync(versionFilePath)) {
        const versionFileContent = await filesystem.readFile(versionFilePath, 'utf-8')
        const versionMatch = versionFileContent.match(/__version__\s*=\s*["']([^"']+)["']/)
        if (versionMatch && versionMatch[1]) {
          const version = versionMatch[1]
          return { version: version.startsWith('v') ? version : `v${version}` }
        }
      }
    } catch (e) {
      this.appLogger.error(`failed to get installed ComfyUI version: ${e}`, this.serviceName)
    }
    return undefined
  }

  /** Main setup generator */
  async *setup(): AsyncIterable<SetupProgress> {
    this.appLogger.info('setting up service', this.serviceName)
    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up comfyUI environment',
      }

      await this.git.ensureInstalled()

      currentStep = 'install comfyUI'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing comfyUI base repo',
      }
      await this.setupComfyUiBaseService()
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installation of comfyUI base repo complete',
      }

      currentStep = 'configure comfyUI'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'configuring comfyUI base repo',
      }
      await this.configureComfyUI()
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'configured comfyUI base repo',
      }

      currentStep = 'install builtin custom nodes'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing builtin custom nodes',
      }
      await this.installBuiltinCustomNodes()
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'builtin custom nodes installation complete',
      }

      currentStep = 'install comfyUI manager'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing ComfyUI Manager custom node',
      }
      await this.installComfyUIManager()
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'ComfyUI Manager installation complete',
      }

      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'dependencies configured',
      }

      currentStep = 'end'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'success',
        debugMessage: 'service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of service failed due to ${e}`, this.serviceName, true)
      this.appLogger.warn(
        `Aborting set up of ${this.serviceName} service environment`,
        this.serviceName,
        true,
      )
      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup comfyUI service due to ${e}`,
        errorDetails,
      }
    }
  }

  /** Check if service directory is valid (git repo at correct revision) */
  private async checkServiceDir(): Promise<boolean> {
    if (!filesystem.existsSync(this.paths.serviceDir)) return false
    try {
      const version = await this.getCurrentVersion()
      if (version === this.revision) {
        this.appLogger.info('comfyUI already cloned, skipping', this.serviceName)
        return true
      }
      this.appLogger.info(
        `ComfyUI version ${version} does not match ${this.revision}. Removing...`,
        this.serviceName,
      )
      throw new Error('Version mismatch')
    } catch (_e) {
      try {
        filesystem.removeSync(this.paths.serviceDir)
      } catch (removeErr) {
        this.appLogger.error(
          `Failed to remove service directory ${this.paths.serviceDir}: ${removeErr}`,
          this.serviceName,
        )
      }
      return false
    }
  }

  /** Clone/checkout ComfyUI, copy dep files, install a single venv for the detected device type */
  private async setupComfyUiBaseService(): Promise<void> {
    await installHijacks()
    if (await this.checkServiceDir()) {
      this.appLogger.info('comfyUI already cloned, skipping', this.serviceName)
    } else {
      await this.git.run(['clone', this.remoteUrl, this.paths.serviceDir])
      await this.git.run(
        ['-C', this.paths.serviceDir, 'checkout', this.revision],
        {},
        this.paths.serviceDir,
      )
    }

    // Copy ComfyUI dependency files
    const comfyUIDepsDir = path.join(aipgBaseDir, 'comfyui-deps')
    const pyprojectTarget = path.join(this.paths.serviceDir, 'pyproject.toml')
    const uvLockTarget = path.join(this.paths.serviceDir, 'uv.lock')
    this.appLogger.info(`Copying dependency files to ${this.paths.serviceDir}`, this.serviceName)
    await filesystem.copyFile(path.join(comfyUIDepsDir, 'pyproject.toml'), pyprojectTarget)
    await filesystem.copyFile(path.join(comfyUIDepsDir, 'uv.lock'), uvLockTarget)

    // Determine which backend to install
    const globalDevices = getCachedDevices()
    this.hasIntelArcGpu = globalDevices.some((d) => d.type === 'intel-arc')
    this.hasNvidiaGpu = globalDevices.some((d) => d.type === 'nvidia')
    const deviceType = this.getRequiredDeviceType()

    this.appLogger.info(
      `GPU detection: Intel Arc=${this.hasIntelArcGpu}, NVIDIA=${this.hasNvidiaGpu} → installing ${deviceType} backend`,
      this.serviceName,
    )

    // Remove stale venv if it exists (e.g. leftover from a previous different backend)
    if (filesystem.existsSync(this.paths.pythonEnvDir)) {
      this.appLogger.info(
        `Removing existing venv at ${this.paths.pythonEnvDir} before reinstall`,
        this.serviceName,
      )
      filesystem.removeSync(this.paths.pythonEnvDir)
    }

    await installComfyUISingleBackend(this.paths.serviceDir, deviceType, () => {
      const localAppData = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local')
      const cachePath =
        process.platform === 'win32'
          ? path.join(localAppData, 'uv', 'cache')
          : process.platform === 'darwin'
            ? path.join(os.homedir(), 'Library', 'Caches', 'uv', 'cache')
            : path.join(os.homedir(), '.cache', 'uv', 'cache')
      this.win.webContents.send('show-toast', {
        type: 'warning',
        message: `UV cache corruption detected. Retrying installation without cache. This may take longer. You can manually clear the cache at ${cachePath}`,
      })
    })

    this.writeInstalledBackendType(deviceType)
    this.appLogger.info(`Installation complete: ${deviceType} backend installed`, this.serviceName)
  }

  /** Configure ComfyUI (hijacks patch + extra model paths) */
  private async configureComfyUI(): Promise<void> {
    try {
      this.appLogger.info('patching hijacks into comfyUI model_management', this.serviceName)
      const hijacksParentDir = path
        .resolve(path.join(this.paths.baseDir, 'hijacks'))
        .replace(/\\/g, '/')
      await patchFile(
        path.join(this.paths.serviceDir, 'comfy/model_management.py'),
        'import torch',
        [
          'import os as _os, sys as _sys',
          `if not _os.environ.get('DISABLE_IPEX') and '${hijacksParentDir}' not in _sys.path: _sys.path.insert(0, '${hijacksParentDir}')`,
          `if not _os.environ.get('DISABLE_IPEX'):`,
          `    from ipex_to_cuda import ipex_init; ipex_init()`,
        ],
      )

      this.appLogger.info('Configuring extra model paths for comfyUI', this.serviceName)
      const extraModelPathsYaml = path.join(this.paths.serviceDir, 'extra_model_paths.yaml')
      const comfyUIModelsBasePath = path
        .resolve(this.paths.baseDir, 'models/ComfyUI')
        .replace(/\\/g, '/')
      const extraModelsYaml = `aipg:
  base_path: "${comfyUIModelsBasePath}"
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
      await fs.promises.writeFile(extraModelPathsYaml, extraModelsYaml, {
        encoding: 'utf-8',
        flag: 'w',
      })
      this.appLogger.info(
        `Configured extra model paths for comfyUI at ${extraModelPathsYaml}`,
        this.serviceName,
      )
    } catch (configError) {
      this.appLogger.error(
        `Failed to configure extra model paths for comfyUI: ${configError}`,
        this.serviceName,
      )
      if (configError instanceof ProcessError) throw configError
      throw new Error(`Failed to configure extra model paths for comfyUI: ${configError}`)
    }
  }

  /** Install builtin custom nodes bundled with the app */
  private async installBuiltinCustomNodes(): Promise<void> {
    try {
      const builtinCustomNodesDir = path.join(aipgBaseDir, 'comfyui-deps', 'custom_nodes')
      if (!filesystem.existsSync(builtinCustomNodesDir)) {
        this.appLogger.info(
          `No builtin custom nodes directory found at ${builtinCustomNodesDir}, skipping`,
          this.serviceName,
        )
        return
      }
      this.appLogger.info(
        `Installing builtin custom nodes from ${builtinCustomNodesDir}`,
        this.serviceName,
      )
      const targetCustomNodesDir = path.join(this.paths.serviceDir, 'custom_nodes')
      await filesystem.ensureDir(targetCustomNodesDir)
      const entries = await filesystem.readdir(builtinCustomNodesDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const sourcePath = path.join(builtinCustomNodesDir, entry.name)
          const targetPath = path.join(targetCustomNodesDir, entry.name)
          this.appLogger.info(
            `Copying builtin custom node ${entry.name} to ${targetPath}`,
            this.serviceName,
          )
          await filesystem.copy(sourcePath, targetPath, { overwrite: true })
        }
      }
      this.appLogger.info(`Builtin custom nodes installation complete`, this.serviceName)
    } catch (error) {
      this.appLogger.error(`Failed to install builtin custom nodes: ${error}`, this.serviceName)
      throw new Error(`Failed to install builtin custom nodes: ${error}`)
    }
  }

  /** Install ComfyUI Manager custom node */
  private async installComfyUIManager(): Promise<void> {
    try {
      const { downloadCustomNode } = await import('../comfyuiTools.ts')
      await downloadCustomNode(
        { username: 'Comfy-Org', repoName: 'ComfyUI-Manager' },
        this.paths.serviceDir,
      )
    } catch (error) {
      this.appLogger.warn(
        `Failed to install ComfyUI Manager: ${error}. Continuing setup.`,
        this.serviceName,
      )
    }
  }
}
