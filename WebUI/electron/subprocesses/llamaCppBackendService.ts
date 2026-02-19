import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { app, BrowserWindow, net } from 'electron'
import { appLoggerInstance } from '../logging/logger.ts'
import { ApiService, createEnhancedErrorDetails, ErrorDetails } from './service.ts'
import { promisify } from 'util'
import { exec } from 'child_process'
import { vulkanDeviceSelectorEnv } from './deviceDetection.ts'
import { LocalSettings } from '../main.ts'
import getPort, { portNumbers } from 'get-port'
import { binary, extract } from './tools.ts'
import { getCachedDevices, filterDevicesByType, GlobalDevice } from './globalDeviceDetection.ts'

const execAsync = promisify(exec)

interface LlamaServerProcess {
  process: ChildProcess
  port: number
  modelPath: string
  modelRepoId: string
  type: 'llm' | 'embedding'
  contextSize?: number
  isReady: boolean
}

export class LlamaCppBackendService implements ApiService {
  readonly name = 'llama-cpp-backend' as BackendServiceName
  baseUrl: string
  port: number
  readonly isRequired: boolean = false
  readonly win: BrowserWindow
  readonly settings: LocalSettings

  // Service directories
  readonly baseDir = app.isPackaged ? process.resourcesPath : path.join(__dirname, '../../../')
  readonly serviceDir: string
  readonly llamaCppDir: string
  readonly llamaCppExePath: string

  readonly zipPath: string
  devices: InferenceDevice[] = [{ id: '0', name: 'Auto select device', selected: true }]

  // Health endpoint
  healthEndpointUrl: string

  // Status tracking
  currentStatus: BackendStatus = 'uninitializedStatus'
  isSetUp: boolean = false
  desiredStatus: BackendStatus = 'uninitializedStatus'

  // Model server processes
  private llamaLlmProcess: LlamaServerProcess | null = null
  private llamaEmbeddingProcess: LlamaServerProcess | null = null
  private currentLlmModel: string | null = null
  private currentContextSize: number | null = null
  private currentEmbeddingModel: string | null = null

  // Store last startup error details for persistence
  private lastStartupErrorDetails: ErrorDetails | null = null

  // Cached installed version for inclusion in service info updates
  private cachedInstalledVersion: { version: string; releaseTag?: string } | undefined = undefined

  // Logger
  readonly appLogger = appLoggerInstance

  private version = 'b7278'

  updatePort(newPort: number) {
    this.port = newPort
    this.baseUrl = `http://127.0.0.1:${newPort}`
    this.healthEndpointUrl = `${this.baseUrl}/health`
  }

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    this.name = name
    this.port = port
    this.win = win
    this.settings = settings
    this.baseUrl = `http://127.0.0.1:${port}`
    this.healthEndpointUrl = `${this.baseUrl}/health`

    // Set up paths
    this.serviceDir = path.resolve(path.join(this.baseDir, 'LlamaCPP'))
    this.llamaCppDir = path.resolve(path.join(this.serviceDir, 'llama-cpp'))
    this.llamaCppExePath = path.resolve(path.join(this.llamaCppDir, binary('llama-server')))
    this.zipPath = path.resolve(path.join(this.serviceDir, 'llama-cpp.zip'))

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
        this.currentLlmModel !== llmModelName ||
        (contextSize && contextSize !== this.currentContextSize) ||
        !this.llamaLlmProcess?.isReady

      if (needsLlmRestart) {
        await this.stopLlamaLlmServer()
        await this.startLlamaLlmServer(llmModelName, contextSize)
        this.appLogger.info(`LLM server ready with model: ${llmModelName}`, this.name)
      } else {
        this.appLogger.info(`LLM server already running with model: ${llmModelName}`, this.name)
      }

      // Handle embedding model if provided
      if (embeddingModelName) {
        const needsEmbeddingRestart =
          this.currentEmbeddingModel !== embeddingModelName || !this.llamaEmbeddingProcess?.isReady

        if (needsEmbeddingRestart) {
          await this.stopLlamaEmbeddingServer()
          await this.startLlamaEmbeddingServer(embeddingModelName)
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

      // we still need to communicate status 'running' to backendServices and UI
      this.start()
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
    if (this.llamaEmbeddingProcess?.isReady) {
      return `http://127.0.0.1:${this.llamaEmbeddingProcess.port}`
    }
    return null
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) return
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))
    this.updateStatus()
  }

  serviceIsSetUp(): boolean {
    return filesystem.existsSync(this.llamaCppExePath)
  }

  async detectDevices() {
    try {
      this.appLogger.info('Using global device detection for LlamaCPP', this.name)

      const globalDevices = getCachedDevices()

      if (globalDevices.length === 0) {
        this.appLogger.warn('No devices found in global cache, using CPU only', this.name)
        this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
        return
      }

      // Filter devices that work with LlamaCPP (NVIDIA, Intel Arc, AMD, and CPU)
      // Note: LlamaCPP uses Vulkan backend which supports NVIDIA, Intel Arc, and AMD GPUs
      const supportedGpuDevices = filterDevicesByType(globalDevices, [
        'nvidia',
        'intel-arc',
        'amd',
      ])

      // Map global devices to InferenceDevice format
      const deviceList: InferenceDevice[] = []

      // Verify device availability with llama-server if it exists
      let verifiedDevices: string[] = []
      if (filesystem.existsSync(this.llamaCppExePath)) {
        try {
          this.appLogger.info('Verifying devices with llama-server --list-devices', this.name)
          const { stdout } = await execAsync(`"${this.llamaCppExePath}" --list-devices`, {
            cwd: this.llamaCppDir,
            env: {
              ...process.env,
            },
            timeout: 10000,
          })

          // Parse the output to get Vulkan device IDs
          const lines = stdout.split('\n').map((line) => line.trim())
          let foundDevicesSection = false
          for (const line of lines) {
            if (line.startsWith('Available devices:')) {
              foundDevicesSection = true
              continue
            }

            if (foundDevicesSection && line.includes(':')) {
              const colonIndex = line.indexOf(':')
              if (colonIndex > 0) {
                let deviceId = line.substring(0, colonIndex).trim()
                // Strip "Vulkan" prefix from device ID
                if (deviceId.startsWith('Vulkan')) {
                  deviceId = deviceId.substring(6)
                }
                verifiedDevices.push(deviceId)
              }
            }
          }
          this.appLogger.info(
            `Verified Vulkan devices: ${JSON.stringify(verifiedDevices)}`,
            this.name,
          )
        } catch (error) {
          this.appLogger.warn(
            `Failed to verify devices with llama-server: ${error}`,
            this.name,
          )
        }
      }

      // Add GPU devices (only if they're verified or if we couldn't verify)
      if (supportedGpuDevices.length > 0) {
        for (let i = 0; i < supportedGpuDevices.length; i++) {
          const device = supportedGpuDevices[i]
          // If we have verified devices, only add this device if it's in the list
          // Otherwise, add all detected devices
          const deviceIndex = i.toString()
          if (verifiedDevices.length === 0 || verifiedDevices.includes(deviceIndex)) {
            deviceList.push({
              id: deviceIndex,
              name: device.name,
              selected: i === 0, // First GPU is selected by default
            })
          }
        }
      }

      // Always add CPU as last option
      deviceList.push({
        id: 'cpu',
        name: 'CPU',
        selected: deviceList.length === 0, // CPU is selected by default if no GPUs
      })

      this.devices = deviceList
      this.appLogger.info(
        `LlamaCPP devices available: ${this.devices.length} (${supportedGpuDevices.length} GPU(s) + CPU)`,
        this.name,
      )
      this.appLogger.info(
        `Device details: ${JSON.stringify(this.devices, null, 2)}`,
        this.name,
      )
    } catch (error) {
      this.appLogger.error(`Failed to detect devices: ${error}`, this.name)
      // Fallback to CPU on error
      this.devices = [{ id: 'cpu', name: 'CPU', selected: true }]
    }
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
      devices: this.devices,
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
      this.version = settings.version
      this.appLogger.info(`applied new LlamaCPP version ${this.version}`, this.name)
    }
  }

  async getInstalledVersion(): Promise<{ version?: string; releaseTag?: string } | undefined> {
    if (!this.isSetUp) return undefined
    try {
      const result = await execAsync(`"${this.llamaCppExePath}" --version`, {
        cwd: this.llamaCppDir,
        env: {
          ...process.env,
        },
        timeout: 10000, // 10 second timeout
      })
      // Parse output like "version: 7278 (03d9a77b8)"
      const versionMatch = result.stderr.match(/version:\s*(\d+)\s*\([^)]+\)/m)
      this.appLogger.info(
        `getInstalledVersion: ${result.stdout}, ${result.stderr}, ${versionMatch}`,
        this.name,
      )
      if (versionMatch && versionMatch[1]) {
        return { version: `b${versionMatch[1]}` }
      }
    } catch (e) {
      this.appLogger.error(`failed to get installed LlamaCPP version: ${e}`, this.name)
    }
    return undefined
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
    this.appLogger.info('setting up service', this.name)

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up LlamaCPP service',
      }

      // Create service directory if it doesn't exist
      if (!filesystem.existsSync(this.serviceDir)) {
        filesystem.mkdirSync(this.serviceDir, { recursive: true })
      }

      currentStep = 'download'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `downloading LlamaCPP`,
      }

      await this.downloadLlamacpp()

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'download complete',
      }

      // Extract Llamacpp ZIP file
      currentStep = 'extract'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extracting LlamaCPP',
      }

      await this.extractLlamacpp()

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'extraction complete',
      }

      this.isSetUp = true
      await this.updateCachedVersion()
      this.setStatus('notYetStarted')

      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: 'service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of service failed due to ${e}`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup LlamaCPP service due to ${e}`,
        errorDetails,
      }
    }
  }

  private async downloadLlamacpp(): Promise<void> {
    const platformArch = process.platform === 'darwin' ? 'macos-arm64' : 'win-vulkan-x64'
    const downloadUrl = `https://github.com/ggml-org/llama.cpp/releases/download/${this.version}/llama-${this.version}-bin-${platformArch}.zip`
    this.appLogger.info(`Downloading Llamacpp from ${downloadUrl}`, this.name)

    // Delete existing zip if it exists
    if (filesystem.existsSync(this.zipPath)) {
      this.appLogger.info(`Removing existing Llamacpp zip file`, this.name)
      filesystem.removeSync(this.zipPath)
    }

    // Using electron net for better proxy support
    const response = await net.fetch(downloadUrl)
    if (!response.ok || response.status !== 200 || !response.body) {
      throw new Error(`Failed to download Llamacpp: ${response.statusText}`)
    }

    const buffer = await response.arrayBuffer()
    await filesystem.writeFile(this.zipPath, Buffer.from(buffer))

    this.appLogger.info(`Llamacpp zip file downloaded successfully`, this.name)
  }

  private async extractLlamacpp(): Promise<void> {
    this.appLogger.info(`Extracting LlamaCPP to ${this.llamaCppDir}`, this.name)

    // Delete existing llamacpp directory if it exists
    if (filesystem.existsSync(this.llamaCppDir)) {
      this.appLogger.info(`Removing existing LlamaCPP directory`, this.name)
      filesystem.removeSync(this.llamaCppDir)
    }

    // Create llamacpp directory
    filesystem.mkdirSync(this.llamaCppDir, { recursive: true })

    // Extract zip file using PowerShell's Expand-Archive
    try {
      await extract(this.zipPath, this.llamaCppDir)
      if (process.platform !== 'win32') {
        filesystem.readdirSync(path.join(this.llamaCppDir, 'build/bin')).forEach((file) => {
          filesystem.renameSync(
            path.join(this.llamaCppDir, 'build/bin', file),
            path.join(this.llamaCppDir, file),
          )
        })
      }

      this.appLogger.info(`LlamaCPP extracted successfully`, this.name)
    } catch (error) {
      this.appLogger.error(`Failed to extract LlamaCPP: ${error}`, this.name)
      throw error
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
    await this.stopLlamaLlmServer()
    await this.stopLlamaEmbeddingServer()

    this.setStatus('stopped')
    return 'stopped'
  }

  // Model server management methods
  private async startLlamaLlmServer(
    modelRepoId: string,
    contextSize?: number,
  ): Promise<LlamaServerProcess> {
    try {
      const modelPath = this.resolveModelPath(modelRepoId)

      const port = await getPort({ port: portNumbers(39100, 39199) })
      this.updatePort(port)
      this.updateStatus()
      const ctxSize = contextSize ?? 8192

      this.appLogger.info(
        `Starting LLM server for model: ${modelRepoId} on port ${port} with context size ${ctxSize}`,
        this.name,
      )

      const selectedDevice = this.devices.find((d) => d.selected)
      const isCpuMode = selectedDevice?.id === 'cpu'

      // Check if device is a slower iGPU (integrated GPU) that might struggle with warmup
      const isSlowerIGPU = selectedDevice?.name.toLowerCase().includes('radeon') &&
                          selectedDevice?.name.match(/\d{3}M/) !== null // AMD iGPUs like "780M"

      if (isCpuMode) {
        this.appLogger.info('LlamaCPP LLM running in CPU mode', this.name)
      } else if (isSlowerIGPU) {
        this.appLogger.info(
          `LlamaCPP LLM running on iGPU: ${selectedDevice?.name} - warmup disabled to prevent OOM`,
          this.name,
        )
      }

      const args = [
        '--model',
        modelPath,
        '--port',
        port.toString(),
        '--gpu-layers',
        isCpuMode ? '0' : '999', // Use CPU-only when CPU is selected
        '--ctx-size',
        ctxSize.toString(),
        '--log-prefix',
        '--jinja',
        '--no-mmap',
        '-fa',
        'off',
      ]

      // Disable warmup for slower iGPUs to prevent OOM during startup
      if (isSlowerIGPU) {
        args.push('--no-warmup')
      }

      const modelFolder = path.dirname(modelPath)
      // find mmproj*.gguf file in the same folder
      const files = await filesystem.readdir(modelFolder)
      const mmprojFiles = files.filter(
        (file) => file.startsWith('mmproj') && file.endsWith('.gguf'),
      )
      const mmprojFile = mmprojFiles.at(0)
      if (mmprojFile) {
        const mmprojPath = path.join(modelFolder, mmprojFile)
        args.push('--mmproj', mmprojPath)
        this.appLogger.info(`Using mmproj file ${mmprojFile} for model ${modelRepoId}`, this.name)
      }

      const env = {
        ...process.env,
        // Only set Vulkan device selector for GPU mode
        ...(isCpuMode ? {} : vulkanDeviceSelectorEnv(selectedDevice?.id)),
      }


      const childProcess = spawn(this.llamaCppExePath, args, {
        cwd: this.llamaCppDir,
        windowsHide: true,
        env,
      })

      const llamaProcess: LlamaServerProcess = {
        process: childProcess,
        port,
        modelPath,
        modelRepoId,
        type: 'llm',
        contextSize: ctxSize,
        isReady: false,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        const msg = message.toString()
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[LLM] ${message}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[LLM] ${message}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[LLM] ${message}`, this.name)
        }
      })

      childProcess.stderr!.on('data', (message) => {
        const msg = message.toString()
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[LLM] ${message}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[LLM] ${message}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[LLM] ${message}`, this.name)
        }
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`LLM server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`LLM server process exited with code: ${code}`, this.name)
        if (this.llamaLlmProcess === llamaProcess) {
          this.llamaLlmProcess = null
          this.currentLlmModel = null
          this.currentContextSize = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(`http://127.0.0.1:${port}/health`, childProcess)
      llamaProcess.isReady = true

      this.llamaLlmProcess = llamaProcess
      this.currentLlmModel = modelRepoId
      this.currentContextSize = ctxSize

      this.appLogger.info(`LLM server ready for model: ${modelRepoId}`, this.name)
      return llamaProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start LLM server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async startLlamaEmbeddingServer(modelRepoId: string): Promise<LlamaServerProcess> {
    try {
      const modelPath = this.resolveEmbeddingModelPath(modelRepoId)
      const port = await getPort({ port: portNumbers(39200, 39299) })

      this.appLogger.info(
        `Starting embedding server for model: ${modelRepoId} on port ${port}`,
        this.name,
      )

      const selectedDevice = this.devices.find((d) => d.selected)
      const isCpuMode = selectedDevice?.id === 'cpu'

      // Check if device is a slower iGPU (integrated GPU) that might struggle with warmup
      const isSlowerIGPU = selectedDevice?.name.toLowerCase().includes('radeon') &&
                          selectedDevice?.name.match(/\d{3}M/) !== null // AMD iGPUs like "780M"

      if (isCpuMode) {
        this.appLogger.info('LlamaCPP embedding server running in CPU mode', this.name)
      } else if (isSlowerIGPU) {
        this.appLogger.info(
          `LlamaCPP embedding server running on iGPU: ${selectedDevice?.name} - warmup disabled to prevent OOM`,
          this.name,
        )
      }

      const args = [
        '--embedding',
        '--model',
        modelPath,
        '--port',
        port.toString(),
        '--log-prefix',
        '-b',
        '1024',
        '-ub',
        '1024',
      ]

      // Disable warmup for slower iGPUs to prevent OOM during startup
      if (isSlowerIGPU) {
        args.push('--no-warmup')
      }

      // Prepare environment
      const env = {
        ...process.env,
        // Only set Vulkan device selector for GPU mode
        ...(isCpuMode ? {} : vulkanDeviceSelectorEnv(selectedDevice?.id)),
      }


      const childProcess = spawn(this.llamaCppExePath, args, {
        cwd: this.llamaCppDir,
        windowsHide: true,
        env,
      })

      const llamaProcess: LlamaServerProcess = {
        process: childProcess,
        port,
        modelPath,
        modelRepoId,
        type: 'embedding',
        isReady: false,
      }

      // Set up process event handlers
      childProcess.stdout!.on('data', (message) => {
        const msg = message.toString()
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[Embedding] ${message}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[Embedding] ${message}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[Embedding] ${message}`, this.name)
        }
      })

      childProcess.stderr!.on('data', (message) => {
        const msg = message.toString()
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[Embedding] ${message}`, this.name)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[Embedding] ${message}`, this.name)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[Embedding] ${message}`, this.name)
        }
      })

      childProcess.on('error', (error: Error) => {
        this.appLogger.error(`Embedding server process error: ${error}`, this.name)
      })

      childProcess.on('exit', (code: number | null) => {
        this.appLogger.info(`Embedding server process exited with code: ${code}`, this.name)
        if (this.llamaEmbeddingProcess === llamaProcess) {
          this.llamaEmbeddingProcess = null
          this.currentEmbeddingModel = null
        }
      })

      // Wait for server to be ready
      await this.waitForServerReady(`http://127.0.0.1:${port}/health`, childProcess)
      llamaProcess.isReady = true

      this.llamaEmbeddingProcess = llamaProcess
      this.currentEmbeddingModel = modelRepoId

      this.appLogger.info(`Embedding server ready for model: ${modelRepoId}`, this.name)
      return llamaProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start embedding server for model ${modelRepoId}: ${error}`,
        this.name,
      )
      throw error
    }
  }

  private async stopLlamaLlmServer(): Promise<void> {
    if (this.llamaLlmProcess) {
      this.appLogger.info(`Stopping LLM server for model: ${this.currentLlmModel}`, this.name)
      this.llamaLlmProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.llamaLlmProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing LLM server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.llamaLlmProcess = null
      this.currentLlmModel = null
      this.currentContextSize = null
    }
  }

  private async stopLlamaEmbeddingServer(): Promise<void> {
    if (this.llamaEmbeddingProcess) {
      this.appLogger.info(
        `Stopping embedding server for model: ${this.currentEmbeddingModel}`,
        this.name,
      )
      this.llamaEmbeddingProcess.process.kill('SIGTERM')

      // Wait a bit for graceful shutdown, then force kill if needed
      await new Promise<void>((resolve) => {
        const currentProcess = this.llamaEmbeddingProcess
        const timeout = setTimeout(() => {
          if (currentProcess) {
            this.appLogger.warn(`Force killing embedding server process`, this.name)
            currentProcess.process.kill('SIGKILL')
          }
          resolve()
        }, 5000)

        if (currentProcess) {
          currentProcess.process.on('exit', () => {
            clearTimeout(timeout)
            resolve()
          })
        } else {
          clearTimeout(timeout)
          resolve()
        }
      })

      this.llamaEmbeddingProcess = null
      this.currentEmbeddingModel = null
    }
  }

  private resolveModelPath(modelRepoId: string): string {
    // Use the same logic as the Python backend
    const modelBasePath = 'models/LLM/ggufLLM'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelPath = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelPath)) {
      throw new Error(`Model file not found: ${modelPath}`)
    }

    return modelPath
  }

  private resolveEmbeddingModelPath(modelRepoId: string): string {
    // Use the same logic as resolveModelPath but with embedding model path
    const modelBasePath = 'models/LLM/embedding/llamaCPP'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelPath = path.resolve(
      path.join(this.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelPath)) {
      throw new Error(`Embedding model file not found: ${modelPath}`)
    }

    return modelPath
  }

  private async waitForServerReady(healthUrl: string, process: ChildProcess): Promise<void> {
    // Increase timeout for iGPUs which are slower (especially during warmup)
    const selectedDevice = this.devices.find((d) => d.selected)
    const isSlowerDevice = selectedDevice?.id === 'cpu' || selectedDevice?.name.toLowerCase().includes('radeon')
    const maxAttempts = isSlowerDevice ? 300 : 120 // 5 minutes for slower devices, 2 minutes for others
    const delayMs = 1000

    this.appLogger.info(
      `Waiting for server to be ready (timeout: ${maxAttempts}s) for device: ${selectedDevice?.name || 'unknown'}`,
      this.name,
    )

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check if process has exited before attempting health check
      if (!process || process.killed) {
        this.appLogger.warn(
          `Process for ${this.name} is not alive, aborting health check`,
          this.name,
        )
        throw new Error(`Process exited before server became ready`)
      }

      try {
        const response = await fetch(healthUrl, {
          method: 'GET',
          signal: AbortSignal.timeout(1000),
        })

        if (response.ok) {
          // Double-check process is still alive before accepting success
          if (!process || process.killed) {
            this.appLogger.warn(
              `Process for ${this.name} exited after health check succeeded, marking as failed`,
              this.name,
            )
            throw new Error(`Process exited after health check succeeded`)
          }
          this.appLogger.info(`Server ready at ${healthUrl}`, this.name)
          return
        }
      } catch (_error) {
        // Server not ready yet, continue waiting
        // But check if process is still alive
        if (!process || process.killed) {
          this.appLogger.warn(`Process for ${this.name} exited during health check wait`, this.name)
          throw new Error(`Process exited during server startup`)
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    throw new Error(`Server failed to start within ${(maxAttempts * delayMs) / 1000} seconds`)
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

  async uninstall(): Promise<void> {
    await this.stop()
    this.appLogger.info(`removing LlamaCPP service directory`, this.name)
    await filesystem.remove(this.serviceDir)
    this.appLogger.info(`removed LlamaCPP service directory`, this.name)
    this.setStatus('notInstalled')
    this.isSetUp = false
    // Clear startup errors when uninstalling
    this.clearLastStartupError()
  }
}
