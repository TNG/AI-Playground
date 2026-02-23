import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import * as filesystem from 'fs-extra'
import { AppLogger } from '../../logging/logger.ts'
import { LlamaServerProcess, LlamaCppPaths } from './llamaCppTypes.ts'
import getPort, { portNumbers } from 'get-port'
import { vulkanDeviceSelectorEnv } from '../deviceDetection.ts'
import { LlamaCppDeviceManager } from './llamaCppDeviceManager.ts'

/**
 * Manages llama-server processes (both LLM and embedding servers)
 */
export class LlamaCppServerManager {
  private readonly paths: LlamaCppPaths
  private readonly appLogger: AppLogger
  private readonly serviceName: BackendServiceName
  private readonly deviceManager: LlamaCppDeviceManager

  private llamaLlmProcess: LlamaServerProcess | null = null
  private llamaEmbeddingProcess: LlamaServerProcess | null = null
  private currentLlmModel: string | null = null
  private currentContextSize: number | null = null
  private currentEmbeddingModel: string | null = null

  constructor(
    paths: LlamaCppPaths,
    appLogger: AppLogger,
    serviceName: BackendServiceName,
    deviceManager: LlamaCppDeviceManager,
  ) {
    this.paths = paths
    this.appLogger = appLogger
    this.serviceName = serviceName
    this.deviceManager = deviceManager
  }

  /**
   * Get the current LLM model name
   */
  getCurrentLlmModel(): string | null {
    return this.currentLlmModel
  }

  /**
   * Get the current context size
   */
  getCurrentContextSize(): number | null {
    return this.currentContextSize
  }

  /**
   * Get the current embedding model name
   */
  getCurrentEmbeddingModel(): string | null {
    return this.currentEmbeddingModel
  }

  /**
   * Check if LLM server is ready
   */
  isLlmServerReady(): boolean {
    return this.llamaLlmProcess?.isReady ?? false
  }

  /**
   * Check if embedding server is ready
   */
  isEmbeddingServerReady(): boolean {
    return this.llamaEmbeddingProcess?.isReady ?? false
  }

  /**
   * Get the embedding server URL if running
   */
  getEmbeddingServerUrl(): string | null {
    if (this.llamaEmbeddingProcess?.isReady) {
      return `http://127.0.0.1:${this.llamaEmbeddingProcess.port}`
    }
    return null
  }

  /**
   * Get the LLM server port if running
   */
  getLlmServerPort(): number | null {
    return this.llamaLlmProcess?.port ?? null
  }

  /**
   * Start the LLM server for a specific model
   */
  async startLlmServer(
    modelRepoId: string,
    contextSize?: number,
    onPortAllocated?: (port: number) => void,
  ): Promise<LlamaServerProcess> {
    try {
      const modelPath = this.resolveModelPath(modelRepoId)
      const port = await getPort({ port: portNumbers(39100, 39199) })
      const ctxSize = contextSize ?? 8192

      // Notify parent of port allocation before starting server
      if (onPortAllocated) {
        onPortAllocated(port)
      }

      this.appLogger.info(
        `Starting LLM server for model: ${modelRepoId} on port ${port} with context size ${ctxSize}`,
        this.serviceName,
      )

      const selectedDevice = this.deviceManager.getSelectedDevice()
      const isCpuMode = selectedDevice?.id === 'cpu'

      // Check if device is a slower iGPU (integrated GPU) that might struggle with warmup
      const isSlowerIGPU =
        selectedDevice?.name.toLowerCase().includes('radeon') &&
        selectedDevice?.name.match(/\d{3}M/) !== null // AMD iGPUs like "780M"

      if (isCpuMode) {
        this.appLogger.info('LlamaCPP LLM running in CPU mode', this.serviceName)
      } else if (isSlowerIGPU) {
        this.appLogger.info(
          `LlamaCPP LLM running on iGPU: ${selectedDevice?.name} - warmup disabled to prevent OOM`,
          this.serviceName,
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
      // Find mmproj*.gguf file in the same folder
      const files = await filesystem.readdir(modelFolder)
      const mmprojFiles = files.filter(
        (file) => file.startsWith('mmproj') && file.endsWith('.gguf'),
      )
      const mmprojFile = mmprojFiles.at(0)
      if (mmprojFile) {
        const mmprojPath = path.join(modelFolder, mmprojFile)
        args.push('--mmproj', mmprojPath)
        this.appLogger.info(
          `Using mmproj file ${mmprojFile} for model ${modelRepoId}`,
          this.serviceName,
        )
      }

      const env = {
        ...process.env,
        // Only set Vulkan device selector for GPU mode
        ...(isCpuMode ? {} : vulkanDeviceSelectorEnv(selectedDevice?.id)),
      }

      const childProcess = spawn(this.paths.llamaCppExePath, args, {
        cwd: this.paths.llamaCppDir,
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
      this.setupProcessHandlers(childProcess, 'LLM', llamaProcess)

      // Wait for server to be ready
      await this.waitForServerReady(`http://127.0.0.1:${port}/health`, childProcess)
      llamaProcess.isReady = true

      this.llamaLlmProcess = llamaProcess
      this.currentLlmModel = modelRepoId
      this.currentContextSize = ctxSize

      this.appLogger.info(`LLM server ready for model: ${modelRepoId}`, this.serviceName)
      return llamaProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start LLM server for model ${modelRepoId}: ${error}`,
        this.serviceName,
      )
      throw error
    }
  }

  /**
   * Start the embedding server for a specific model
   */
  async startEmbeddingServer(modelRepoId: string): Promise<LlamaServerProcess> {
    try {
      const modelPath = this.resolveEmbeddingModelPath(modelRepoId)
      const port = await getPort({ port: portNumbers(39200, 39299) })

      this.appLogger.info(
        `Starting embedding server for model: ${modelRepoId} on port ${port}`,
        this.serviceName,
      )

      const selectedDevice = this.deviceManager.getSelectedDevice()
      const isCpuMode = selectedDevice?.id === 'cpu'

      // Check if device is a slower iGPU (integrated GPU) that might struggle with warmup
      const isSlowerIGPU =
        selectedDevice?.name.toLowerCase().includes('radeon') &&
        selectedDevice?.name.match(/\d{3}M/) !== null // AMD iGPUs like "780M"

      if (isCpuMode) {
        this.appLogger.info('LlamaCPP embedding server running in CPU mode', this.serviceName)
      } else if (isSlowerIGPU) {
        this.appLogger.info(
          `LlamaCPP embedding server running on iGPU: ${selectedDevice?.name} - warmup disabled to prevent OOM`,
          this.serviceName,
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

      const childProcess = spawn(this.paths.llamaCppExePath, args, {
        cwd: this.paths.llamaCppDir,
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
      this.setupProcessHandlers(childProcess, 'Embedding', llamaProcess)

      // Wait for server to be ready
      await this.waitForServerReady(`http://127.0.0.1:${port}/health`, childProcess)
      llamaProcess.isReady = true

      this.llamaEmbeddingProcess = llamaProcess
      this.currentEmbeddingModel = modelRepoId

      this.appLogger.info(`Embedding server ready for model: ${modelRepoId}`, this.serviceName)
      return llamaProcess
    } catch (error) {
      this.appLogger.error(
        `Failed to start embedding server for model ${modelRepoId}: ${error}`,
        this.serviceName,
      )
      throw error
    }
  }

  /**
   * Stop the LLM server
   */
  async stopLlmServer(): Promise<void> {
    if (this.llamaLlmProcess) {
      this.appLogger.info(
        `Stopping LLM server for model: ${this.currentLlmModel}`,
        this.serviceName,
      )
      await this.killProcess(this.llamaLlmProcess, 'LLM')
      this.llamaLlmProcess = null
      this.currentLlmModel = null
      this.currentContextSize = null
    }
  }

  /**
   * Stop the embedding server
   */
  async stopEmbeddingServer(): Promise<void> {
    if (this.llamaEmbeddingProcess) {
      this.appLogger.info(
        `Stopping embedding server for model: ${this.currentEmbeddingModel}`,
        this.serviceName,
      )
      await this.killProcess(this.llamaEmbeddingProcess, 'Embedding')
      this.llamaEmbeddingProcess = null
      this.currentEmbeddingModel = null
    }
  }

  /**
   * Stop all servers
   */
  async stopAllServers(): Promise<void> {
    await this.stopLlmServer()
    await this.stopEmbeddingServer()
  }

  /**
   * Setup event handlers for a process
   */
  private setupProcessHandlers(
    childProcess: ChildProcess,
    processType: string,
    llamaProcess: LlamaServerProcess,
  ): void {
    const stdout = childProcess.stdout
    if (stdout) {
      stdout.on('data', (message) => {
        const msg = message.toString()
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[${processType}] ${msg}`, this.serviceName)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[${processType}] ${msg}`, this.serviceName)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[${processType}] ${msg}`, this.serviceName)
        }
      })
    }

    const stderr = childProcess.stderr
    if (stderr) {
      stderr.on('data', (message) => {
        const msg = message.toString()
        if (msg.startsWith('I ')) {
          this.appLogger.info(`[${processType}] ${msg}`, this.serviceName)
        } else if (msg.startsWith('W ')) {
          this.appLogger.warn(`[${processType}] ${msg}`, this.serviceName)
        } else if (msg.startsWith('E ')) {
          this.appLogger.error(`[${processType}] ${msg}`, this.serviceName)
        }
      })
    }

    childProcess.on('error', (error: Error) => {
      this.appLogger.error(`${processType} server process error: ${error}`, this.serviceName)
    })

    childProcess.on('exit', (code: number | null) => {
      this.appLogger.info(
        `${processType} server process exited with code: ${code}`,
        this.serviceName,
      )
      if (llamaProcess.type === 'llm' && this.llamaLlmProcess === llamaProcess) {
        this.llamaLlmProcess = null
        this.currentLlmModel = null
        this.currentContextSize = null
      } else if (llamaProcess.type === 'embedding' && this.llamaEmbeddingProcess === llamaProcess) {
        this.llamaEmbeddingProcess = null
        this.currentEmbeddingModel = null
      }
    })
  }

  /**
   * Kill a process gracefully or forcefully
   */
  private async killProcess(llamaProcess: LlamaServerProcess, processType: string): Promise<void> {
    llamaProcess.process.kill('SIGTERM')

    // Wait a bit for graceful shutdown, then force kill if needed
    await new Promise<void>((resolve) => {
      const exitHandler = () => {
        clearTimeout(timeout)
        llamaProcess.process.off('exit', exitHandler)
        resolve()
      }

      const timeout = setTimeout(() => {
        if (llamaProcess) {
          this.appLogger.warn(`Force killing ${processType} server process`, this.serviceName)
          llamaProcess.process.off('exit', exitHandler)
          llamaProcess.process.kill('SIGKILL')
        }
        resolve()
      }, 5000)

      llamaProcess.process.on('exit', exitHandler)
    })
  }

  /**
   * Wait for a server to be ready by polling its health endpoint
   */
  private async waitForServerReady(healthUrl: string, process: ChildProcess): Promise<void> {
    // Increase timeout for iGPUs which are slower (especially during warmup)
    const selectedDevice = this.deviceManager.getSelectedDevice()
    const isSlowerDevice =
      selectedDevice?.id === 'cpu' || selectedDevice?.name.toLowerCase().includes('radeon')
    const maxAttempts = isSlowerDevice ? 300 : 120 // 5 minutes for slower devices, 2 minutes for others
    const delayMs = 1000

    this.appLogger.info(
      `Waiting for server to be ready (timeout: ${maxAttempts}s) for device: ${selectedDevice?.name || 'unknown'}`,
      this.serviceName,
    )

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      // Check if process has exited before attempting health check
      if (!process || process.killed) {
        this.appLogger.warn(
          `Process for ${this.serviceName} is not alive, aborting health check`,
          this.serviceName,
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
              `Process for ${this.serviceName} exited after health check succeeded, marking as failed`,
              this.serviceName,
            )
            throw new Error(`Process exited after health check succeeded`)
          }
          this.appLogger.info(`Server ready at ${healthUrl}`, this.serviceName)
          return
        }
      } catch (_error) {
        // Server not ready yet, continue waiting
        // But check if process is still alive
        if (!process || process.killed) {
          this.appLogger.warn(
            `Process for ${this.serviceName} exited during health check wait`,
            this.serviceName,
          )
          throw new Error(`Process exited during server startup`)
        }
      }

      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }

    throw new Error(`Server failed to start within ${(maxAttempts * delayMs) / 1000} seconds`)
  }

  /**
   * Resolve model path from repo ID
   */
  private resolveModelPath(modelRepoId: string): string {
    // Use the same logic as the Python backend
    const modelBasePath = 'models/LLM/ggufLLM'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelPath = path.resolve(
      path.join(this.paths.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelPath)) {
      throw new Error(`Model file not found: ${modelPath}`)
    }

    return modelPath
  }

  /**
   * Resolve embedding model path from repo ID
   */
  private resolveEmbeddingModelPath(modelRepoId: string): string {
    // Use the same logic as resolveModelPath but with embedding model path
    const modelBasePath = 'models/LLM/embedding/llamaCPP'
    const [namespace, repo, ...model] = modelRepoId.split('/')
    const modelPath = path.resolve(
      path.join(this.paths.baseDir, modelBasePath, `${namespace}---${repo}`, model.join('/')),
    )

    if (!filesystem.existsSync(modelPath)) {
      throw new Error(`Embedding model file not found: ${modelPath}`)
    }

    return modelPath
  }
}
