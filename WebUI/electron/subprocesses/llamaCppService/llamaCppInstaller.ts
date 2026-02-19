import path from 'node:path'
import * as filesystem from 'fs-extra'
import { net } from 'electron'
import { AppLogger } from '../../logging/logger.ts'
import { LlamaCppPaths, LlamaCppVersion } from './llamaCppTypes.ts'
import { promisify } from 'util'
import { exec } from 'child_process'
import { extract } from '../tools.ts'
import { createEnhancedErrorDetails } from '../service.ts'

const execAsync = promisify(exec)

/**
 * Handles installation, setup, and version management for LlamaCPP
 */
export class LlamaCppInstaller {
  private readonly paths: LlamaCppPaths
  private readonly appLogger: AppLogger
  private readonly serviceName: BackendServiceName
  private version: string

  constructor(
    paths: LlamaCppPaths,
    appLogger: AppLogger,
    serviceName: BackendServiceName,
    version: string,
  ) {
    this.paths = paths
    this.appLogger = appLogger
    this.serviceName = serviceName
    this.version = version
  }

  /**
   * Check if LlamaCPP is already set up
   */
  isSetUp(): boolean {
    return filesystem.existsSync(this.paths.llamaCppExePath)
  }

  /**
   * Update the version to install
   */
  updateVersion(version: string): void {
    this.version = version
    this.appLogger.info(`Updated LlamaCPP version to ${this.version}`, this.serviceName)
  }

  /**
   * Get the currently installed version
   */
  async getInstalledVersion(): Promise<LlamaCppVersion | undefined> {
    if (!this.isSetUp()) return undefined

    try {
      const result = await execAsync(`"${this.paths.llamaCppExePath}" --version`, {
        cwd: this.paths.llamaCppDir,
        env: {
          ...process.env,
        },
        timeout: 10000, // 10 second timeout
      })

      // Parse output like "version: 7278 (03d9a77b8)"
      const versionMatch = result.stderr.match(/version:\s*(\d+)\s*\([^)]+\)/m)
      this.appLogger.info(
        `getInstalledVersion: ${result.stdout}, ${result.stderr}, ${versionMatch}`,
        this.serviceName,
      )

      if (versionMatch && versionMatch[1]) {
        return { version: `b${versionMatch[1]}` }
      }
    } catch (e) {
      this.appLogger.error(`Failed to get installed LlamaCPP version: ${e}`, this.serviceName)
    }

    return undefined
  }

  /**
   * Download LlamaCPP binary archive
   */
  async download(): Promise<void> {
    const platformArch = process.platform === 'darwin' ? 'macos-arm64' : 'win-vulkan-x64'
    const downloadUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${this.version}/llama-${this.version}-bin-${platformArch}.zip`
    this.appLogger.info(`Downloading LlamaCPP from ${downloadUrl}`, this.serviceName)

    // Delete existing zip if it exists
    if (filesystem.existsSync(this.paths.zipPath)) {
      this.appLogger.info(`Removing existing LlamaCPP zip file`, this.serviceName)
      filesystem.removeSync(this.paths.zipPath)
    }

    // Using electron net for better proxy support
    const response = await net.fetch(downloadUrl)
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new Error(`Failed to download LlamaCPP: ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    await filesystem.writeFile(this.paths.zipPath, Buffer.from(buffer))

    this.appLogger.info(`LlamaCPP zip file downloaded successfully`, this.serviceName)
  }

  /**
   * Extract LlamaCPP binary archive
   */
  async extract(): Promise<void> {
    this.appLogger.info(`Extracting LlamaCPP to ${this.paths.llamaCppDir}`, this.serviceName)

    // Delete existing llamacpp directory if it exists
    if (filesystem.existsSync(this.paths.llamaCppDir)) {
      this.appLogger.info(`Removing existing LlamaCPP directory`, this.serviceName)
      filesystem.removeSync(this.paths.llamaCppDir)
    }

    // Create llamacpp directory
    filesystem.mkdirSync(this.paths.llamaCppDir, { recursive: true })

    // Extract zip file
    try {
      await extract(this.paths.zipPath, this.paths.llamaCppDir)
      if (process.platform !== 'win32') {
        filesystem.readdirSync(path.join(this.paths.llamaCppDir, 'build/bin')).forEach((file) => {
          filesystem.renameSync(
            path.join(this.paths.llamaCppDir, 'build/bin', file),
            path.join(this.paths.llamaCppDir, file),
          )
        })
      }

      this.appLogger.info(`LlamaCPP extracted successfully`, this.serviceName)
    } catch (error) {
      this.appLogger.error(`Failed to extract LlamaCPP: ${error}`, this.serviceName)
      throw error
    }
  }

  /**
   * Perform complete installation setup
   */
  async *setup(): AsyncIterable<SetupProgress> {
    this.appLogger.info('Setting up LlamaCPP service', this.serviceName)

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'Starting to set up LlamaCPP service',
      }

      // Create service directory if it doesn't exist
      if (!filesystem.existsSync(this.paths.serviceDir)) {
        filesystem.mkdirSync(this.paths.serviceDir, { recursive: true })
      }

      currentStep = 'download'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: `Downloading LlamaCPP`,
      }

      await this.download()

      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'Download complete',
      }

      // Extract LlamaCPP ZIP file
      currentStep = 'extract'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'Extracting LlamaCPP',
      }

      await this.extract()

      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'executing',
        debugMessage: 'Extraction complete',
      }

      currentStep = 'end'
      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'success',
        debugMessage: 'Service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Setup of service failed due to ${e}`, this.serviceName, true)

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)

      yield {
        serviceName: this.serviceName,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup LlamaCPP service due to ${e}`,
        errorDetails,
      }
    }
  }

  /**
   * Uninstall LlamaCPP
   */
  async uninstall(): Promise<void> {
    this.appLogger.info(`Removing LlamaCPP service directory`, this.serviceName)
    await filesystem.remove(this.paths.serviceDir)
    this.appLogger.info(`Removed LlamaCPP service directory`, this.serviceName)
  }
}
