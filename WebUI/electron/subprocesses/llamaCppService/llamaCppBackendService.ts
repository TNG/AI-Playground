import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import { appLoggerInstance } from '../../logging/logger.ts'
import { ApiService, ErrorDetails } from '../service.ts'
import { LocalSettings } from '../../main.ts'
import { binary } from '../tools.ts'
import { LlamaCppPaths, LlamaCppVersion } from './llamaCppTypes.ts'
import { LlamaCppInstaller } from './llamaCppInstaller.ts'
import { LlamaCppDeviceManager } from './llamaCppDeviceManager.ts'
import { LlamaCppServerManager } from './llamaCppServerManager.ts'

/** Default LlamaCPP release tag to install. Update this constant to upgrade the bundled version. */
const LLAMA_CPP_VERSION = 'b7278'

/**
 * Main service class that orchestrates LlamaCPP backend operations
 */
export class LlamaCppBackendService implements ApiService {
  readonly name: BackendServiceName = 'llamacpp-backend'
  baseUrl: string
  port: number
  readonly isRequired: boolean = false
  readonly win: BrowserWindow
  readonly settings: LocalSettings

  // Service paths
  private readonly paths: LlamaCppPaths

  // Health endpoint
  healthEndpointUrl: string

  // Status tracking
  currentStatus: BackendStatus = 'uninitializedStatus'
  isSetUp: boolean = false
  desiredStatus: BackendStatus = 'uninitializedStatus'

  // Store last startup error details for persistence
  private lastStartupErrorDetails: ErrorDetails | null = null

  // Cached installed version for inclusion in service info updates
  private cachedInstalledVersion: LlamaCppVersion | undefined = undefined

  // Logger
  readonly appLogger = appLoggerInstance

  // Sub-components
  private readonly installer: LlamaCppInstaller
  private readonly deviceManager: LlamaCppDeviceManager
  private readonly serverManager: LlamaCppServerManager

  constructor(port: number, win: BrowserWindow, settings: LocalSettings) {
    this.port = port
    this.win = win
    this.settings = settings
    this.baseUrl = `http://127.0.0.1:${port}`
    this.healthEndpointUrl = `${this.baseUrl}/health`

    // Set up paths
    // Uses same pattern as other services in subprocesses/ subdirectories (e.g., uvBasedBackends/)
    const baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')

    const serviceDir = path.resolve(path.join(baseDir, 'LlamaCPP'))
    const llamaCppDir = path.resolve(path.join(serviceDir, 'llama-cpp'))
    const llamaCppExePath = path.resolve(path.join(llamaCppDir, binary('llama-server')))
    const zipPath = path.resolve(path.join(serviceDir, 'llama-cpp.zip'))

    this.paths = {
      baseDir,
      serviceDir,
      llamaCppDir,
      llamaCppExePath,
      zipPath,
    }

    // Initialize sub-components
    this.installer = new LlamaCppInstaller(this.paths, this.appLogger, this.name, LLAMA_CPP_VERSION)
    this.deviceManager = new LlamaCppDeviceManager(this.paths, this.appLogger, this.name)
    this.serverManager = new LlamaCppServerManager(
      this.paths,
      this.appLogger,
      this.name,
      this.deviceManager,
    )

    // Check if already set up
    this.isSetUp = this.serviceIsSetUp()
    this.appLogger.info(`Service ${this.name} isSetUp: ${this.isSetUp}`, this.name)

    // Cache version on startup if already set up
    if (this.isSetUp) {
      this.updateCachedVersion().then(() => {
        this.updateStatus()
      })
    }
  }

  updatePort(newPort: number) {
    this.port = newPort
    this.baseUrl = `http://127.0.0.1:${newPort}`
    this.healthEndpointUrl = `${this.baseUrl}/health`
  }

  serviceIsSetUp(): boolean {
    return this.installer.isSetUp()
  }

  async detectDevices() {
    await this.deviceManager.detectDevices()
    this.updateStatus()
  }

  async selectDevice(deviceId: string): Promise<void> {
    await this.deviceManager.selectDevice(deviceId)
    this.updateStatus()
  }

  get_info(): ApiServiceInformation {
    if (this.currentStatus === 'uninitializedStatus') {
      this.currentStatus = this.isSetUp ? 'notYetStarted' : 'notInstalled'
    }
    return {
      serviceName: this.name,
      status: this.currentStatus,
      baseUrl: this.baseUrl,
      port: this.port,
      isSetUp: this.isSetUp,
      isRequired: this.isRequired,
      devices: this.deviceManager.getDevices(),
      errorDetails: this.lastStartupErrorDetails,
      installedVersion: this.cachedInstalledVersion,
    }
  }

  setStatus(status: BackendStatus) {
    this.currentStatus = status
    this.updateStatus()
  }

  updateStatus() {
    this.win.webContents.send('serviceInfoUpdate', this.get_info())
  }

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.version) {
      this.installer.updateVersion(settings.version)
    }
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    return await this.installer.getInstalledVersion()
  }

  /**
   * Updates the cached installed version for inclusion in service info updates.
   */
  private async updateCachedVersion(): Promise<void> {
    try {
      const version = await this.getInstalledVersion()
      if (version && version.version) {
        this.cachedInstalledVersion = {
          version: version.version,
          ...(version.releaseTag && { releaseTag: version.releaseTag }),
        }
      } else {
        this.cachedInstalledVersion = undefined
      }
    } catch (error) {
      this.appLogger.warn(`Failed to get installed version: ${error}`, this.name)
      this.cachedInstalledVersion = undefined
    }
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')

    for await (const progress of this.installer.setup()) {
      yield progress
    }

    // Update setup status
    this.isSetUp = this.installer.isSetUp()
    if (this.isSetUp) {
      await this.updateCachedVersion()
      this.setStatus('notYetStarted')
    } else {
      this.setStatus('installationFailed')
    }
  }

  async start(): Promise<BackendStatus> {
    // In this architecture, model servers are started on-demand via ensureBackendReadiness
    // This method is kept for ApiService interface compatibility
    if (this.currentStatus === 'running') {
      this.clearLastStartupError()
      return 'running'
    }

    this.appLogger.info(
      `${this.name} service ready - model servers will start on-demand`,
      this.name,
    )
    this.desiredStatus = 'running'
    this.currentStatus = 'running'
    this.clearLastStartupError()
    this.updateStatus()
    return 'running'
  }

  async stop(): Promise<BackendStatus> {
    this.appLogger.info(
      `Stopping backend ${this.name}. It was in state ${this.currentStatus}`,
      this.name,
    )
    this.desiredStatus = 'stopped'
    this.setStatus('stopping')

    // Stop all model servers
    await this.serverManager.stopAllServers()

    this.setStatus('stopped')
    return 'stopped'
  }

  async uninstall(): Promise<void> {
    await this.stop()
    await this.installer.uninstall()
    this.setStatus('notInstalled')
    this.isSetUp = false
    this.clearLastStartupError()
  }

  /**
   * Ensure backend readiness for specific models
   * This is the main entry point for starting model servers on-demand
   */
  async ensureBackendReadiness(
    llmModelName: string,
    embeddingModelName?: string,
    contextSize?: number,
  ): Promise<void> {
    this.appLogger.info(
      `Ensuring LlamaCPP backend readiness for LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}, Context: ${contextSize ?? 'default'}`,
      this.name,
    )

    try {
      // Handle LLM model
      const needsLlmRestart =
        this.serverManager.getCurrentLlmModel() !== llmModelName ||
        (contextSize && contextSize !== this.serverManager.getCurrentContextSize()) ||
        !this.serverManager.isLlmServerReady()

      if (needsLlmRestart) {
        await this.serverManager.stopLlmServer()
        // Start the LLM server - it will allocate a port and start the server
        await this.serverManager.startLlmServer(llmModelName, contextSize, (port) => {
          // Callback to update port immediately after allocation, before server starts
          this.updatePort(port)
          this.updateStatus()
        })
        this.appLogger.info(`LLM server ready with model: ${llmModelName}`, this.name)
      } else {
        this.appLogger.info(`LLM server already running with model: ${llmModelName}`, this.name)
      }

      // Handle embedding model if provided
      if (embeddingModelName) {
        const needsEmbeddingRestart =
          this.serverManager.getCurrentEmbeddingModel() !== embeddingModelName ||
          !this.serverManager.isEmbeddingServerReady()

        if (needsEmbeddingRestart) {
          await this.serverManager.stopEmbeddingServer()
          await this.serverManager.startEmbeddingServer(embeddingModelName)
          this.appLogger.info(`Embedding server ready with model: ${embeddingModelName}`, this.name)
        } else {
          this.appLogger.info(
            `Embedding server already running with model: ${embeddingModelName}`,
            this.name,
          )
        }
      }

      this.appLogger.info(
        `LlamaCPP backend fully ready - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}`,
        this.name,
      )

      // Communicate status 'running' to backendServices and UI
      await this.start()
    } catch (error) {
      this.appLogger.error(
        `Failed to ensure backend readiness - LLM: ${llmModelName}, Embedding: ${embeddingModelName ?? 'none'}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  /**
   * Get the embedding server URL if an embedding server is running
   * @returns The embedding server base URL, or null if no embedding server is running
   */
  getEmbeddingServerUrl(): string | null {
    return this.serverManager.getEmbeddingServerUrl()
  }

  // Error management methods for startup failures
  setLastStartupError(errorDetails: ErrorDetails): void {
    this.lastStartupErrorDetails = errorDetails
  }

  getLastStartupError(): ErrorDetails | null {
    return this.lastStartupErrorDetails
  }

  clearLastStartupError(): void {
    this.lastStartupErrorDetails = null
  }
}
