import path from 'node:path'
import fs from 'fs'
import * as filesystem from 'fs-extra'
import { AppLogger } from '../../logging/logger.ts'
import { ComfyUIPaths, ComfyUIVersion } from './comfyUITypes.ts'
import { GitService, installHijacks, patchFile, createEnhancedErrorDetails } from '../service.ts'
import { aipgBaseDir, installComfyUIBackend } from '../uvBasedBackends/uv.ts'
import { ProcessError } from '../osProcessHelper.ts'
import { getCachedDevices } from '../globalDeviceDetection.ts'
import { BrowserWindow } from 'electron'

/**
 * Handles installation, setup, and version management for ComfyUI
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

  /**
   * Get git directory path
   */
  getGitDir(): string {
    return this.git.dir
  }

  /**
   * Check if ComfyUI is already set up
   */
  async serviceIsSetUp(): Promise<boolean> {
    const dirsExist = filesystem.existsSync(this.paths.serviceDir)
    this.appLogger.info(`Checking if comfyUI directories exist: ${dirsExist}`, this.serviceName)
    if (!dirsExist) return false

    setTimeout(async () => {
      const version = await this.getCurrentVersion()
      if (version) {
        this.appLogger.info(`comfyUI version ${version} detected`, this.serviceName)
        this.revision = version
      }
    })

    // Check if CPU venv exists (required)
    const cpuVenvExists = filesystem.existsSync(this.paths.pythonEnvDirCpu)
    if (!cpuVenvExists) {
      this.appLogger.info(
        `CPU venv does not exist at ${this.paths.pythonEnvDirCpu}, needs installation`,
        this.serviceName,
      )
      return false
    }

    // Check if XPU venv exists (optional)
    if (filesystem.existsSync(this.paths.pythonEnvDirXpu)) {
      this.hasIntelArcGpu = true
      this.appLogger.info(`XPU venv found, Intel Arc GPU support available`, this.serviceName)
    }

    // Check if CUDA venv exists (optional)
    if (filesystem.existsSync(this.paths.pythonEnvDirCuda)) {
      this.hasNvidiaGpu = true
      this.appLogger.info(`CUDA venv found, NVIDIA GPU support available`, this.serviceName)
    }

    this.appLogger.info(
      `ComfyUI is set up (CPU: ${cpuVenvExists}, XPU: ${this.hasIntelArcGpu}, CUDA: ${this.hasNvidiaGpu})`,
      this.serviceName,
    )
    return true
  }

  /**
   * Update the version to install
   */
  updateVersion(version: string): void {
    this.revision = version
    this.appLogger.info(`applied new comfyUI version ${this.revision}`, this.serviceName)
  }

  /**
   * Get the current git version
   */
  async getCurrentVersion(): Promise<string | undefined> {
    try {
      // First, try to get the current branch or tag name
      const branchOutput = await this.git.run([
        '-C',
        this.paths.serviceDir,
        'rev-parse',
        '--abbrev-ref',
        'HEAD',
      ])
      const branchName = branchOutput.trim()

      // If we're not in detached HEAD state, return the branch name
      if (branchName !== 'HEAD') {
        return branchName
      }

      // If in detached HEAD state, try to get the exact tag
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
        // No exact tag match, fall back to short commit hash
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

  /**
   * Get the currently installed version
   */
  async getInstalledVersion(): Promise<ComfyUIVersion | undefined> {
    if (!(await this.serviceIsSetUp())) return undefined
    try {
      const versionFilePath = path.join(this.paths.serviceDir, 'comfyui_version.py')
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
      this.appLogger.error(`failed to get installed ComfyUI version: ${e}`, this.serviceName)
    }
    return undefined
  }

  /**
   * Main setup generator
   */
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
        debugMessage: `installing comfyUI base repo`,
      }
      await this.setupComfyUiBaseService()
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: `installation of comfyUI base repo complete`,
      }

      currentStep = 'configure comfyUI'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: `configuring comfyUI base repo`,
      }
      await this.configureComfyUI()
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: `configured comfyUI base repo`,
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
        debugMessage: `service set up completely`,
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

  /**
   * Check if service directory is valid
   */
  private async checkServiceDir(): Promise<boolean> {
    if (!filesystem.existsSync(this.paths.serviceDir)) {
      return false
    }

    // Check if it's a valid git repo
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
      } finally {
        return false
      }
    }
  }

  /**
   * Setup ComfyUI base service
   */
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
    const pyprojectSource = path.join(comfyUIDepsDir, 'pyproject.toml')
    const uvLockSource = path.join(comfyUIDepsDir, 'uv.lock')
    const pyprojectTarget = path.join(this.paths.serviceDir, 'pyproject.toml')
    const uvLockTarget = path.join(this.paths.serviceDir, 'uv.lock')

    // Copy dependency specification files
    this.appLogger.info(
      `Copying pyproject.toml from ${pyprojectSource} to ${pyprojectTarget}`,
      this.serviceName,
    )
    await filesystem.copyFile(pyprojectSource, pyprojectTarget)

    this.appLogger.info(`Copying uv.lock from ${uvLockSource} to ${uvLockTarget}`, this.serviceName)
    await filesystem.copyFile(uvLockSource, uvLockTarget)

    // Install dependencies with triple venv support
    this.appLogger.info('Installing ComfyUI with triple venv support', this.serviceName)

    const globalDevices = getCachedDevices()
    const hasIntelArcGpu = globalDevices.some((d) => d.type === 'intel-arc')
    const hasNvidiaGpu = globalDevices.some((d) => d.type === 'nvidia')

    this.appLogger.info(
      `GPU detection: Intel Arc=${hasIntelArcGpu}, NVIDIA=${hasNvidiaGpu}`,
      this.serviceName,
    )

    const results = await installComfyUIBackend(
      this.paths.serviceDir,
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
      this.serviceName,
    )
  }

  /**
   * Configure ComfyUI (hijacks, model paths)
   */
  private async configureComfyUI(): Promise<void> {
    try {
      this.appLogger.info('patching hijacks into comfyUI model_management', this.serviceName)
      await patchFile(
        path.join(this.paths.serviceDir, 'comfy/model_management.py'),
        'from comfy.model_management import get_model',
        ['from ipex_to_cuda import ipex_init', 'ipex_init()'],
      )

      this.appLogger.info('Configuring extra model paths for comfyUI', this.serviceName)
      const extraModelPathsYaml = path.join(this.paths.serviceDir, 'extra_model_paths.yaml')
      const comfyUIModelsBasePath = path.resolve(this.paths.baseDir, 'models/ComfyUI')
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
      // Re-throw ProcessError instances to preserve enhanced error details
      if (configError instanceof ProcessError) {
        throw configError
      }
      // For other errors, wrap with context
      throw new Error(`Failed to configure extra model paths for comfyUI: ${configError}`)
    }
  }

  /**
   * Install builtin custom nodes
   */
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

      if (!filesystem.existsSync(targetCustomNodesDir)) {
        this.appLogger.info(
          `Creating custom_nodes directory at ${targetCustomNodesDir}`,
          this.serviceName,
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
            this.serviceName,
          )

          await filesystem.copy(sourcePath, targetPath, { overwrite: true })

          this.appLogger.info(
            `Successfully installed builtin custom node ${entry.name}`,
            this.serviceName,
          )
        }
      }

      this.appLogger.info(`Builtin custom nodes installation complete`, this.serviceName)
    } catch (error) {
      this.appLogger.error(`Failed to install builtin custom nodes: ${error}`, this.serviceName)
      throw new Error(`Failed to install builtin custom nodes: ${error}`)
    }
  }

  /**
   * Install ComfyUI Manager custom node
   */
  private async installComfyUIManager(): Promise<void> {
    try {
      const { downloadCustomNode } = await import('../comfyuiTools.ts')
      const managerNode = {
        username: 'Comfy-Org',
        repoName: 'ComfyUI-Manager',
      }
      await downloadCustomNode(managerNode, this.paths.serviceDir)
    } catch (error) {
      // Log warning but don't fail setup
      this.appLogger.warn(
        `Failed to install ComfyUI Manager: ${error}. Continuing setup.`,
        this.serviceName,
      )
    }
  }
}
