import { ChildProcess, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { GitService, LongLivedPythonApiService, createEnhancedErrorDetails } from './service.ts'
import { aipgBaseDir, checkBackend, installBackend } from './uvBasedBackends/uv.ts'

export type GpuHardwareDevice = {
  device: string
  name: string
  gpuDeviceId: string | null
}

export type HardwareDetectionResult = {
  success: boolean
  gpuDevices: GpuHardwareDevice[]
  error?: string
}

export class AiBackendService extends LongLivedPythonApiService {
  isSetUp: boolean = false
  readonly isRequired = true

  private loopbackAuthToken: string = randomBytes(32).toString('hex')

  getLoopbackAuthToken(): string {
    return this.loopbackAuthToken
  }

  readonly serviceFolder = 'service'

  get baseDir(): string {
    return path.resolve(path.join(aipgBaseDir, this.serviceFolder))
  }
  get serviceDir(): string {
    return this.baseDir
  }
  get pythonEnvDir(): string {
    return path.resolve(path.join(this.serviceDir, '.venv'))
  }

  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()
  healthEndpointUrl = `${this.baseUrl}/healthy`

  async serviceIsSetUp(): Promise<boolean> {
    const result = await checkBackend(this.serviceFolder)
      .then(() => true)
      .catch(() => false)
    this.appLogger.info(`Service ${this.name} isSetUp: ${result}`, this.name)
    return result
  }

  async detectDevices(): Promise<void> {}

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info(`setting up ${this.name} service`, this.name)
    let currentStep = 'start'

    try {
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `starting to set up ${this.name} environment`,
      }

      await this.git.ensureInstalled()

      currentStep = 'install dependencies'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing dependencies',
      }

      const extraInstallEnv =
        this.settings.productMode === 'nvidia' ? { UV_TORCH_BACKEND: 'cu128' } : undefined
      await installBackend(this.serviceFolder, undefined, extraInstallEnv)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'dependencies installed',
      }

      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: `${this.name} service set up completely`,
      }
    } catch (e) {
      this.appLogger.warn(`Set up of ${this.name} service failed due to ${e}`, this.name, true)
      this.setStatus('installationFailed')
      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to set up ${this.name} environment due to ${e}`,
        errorDetails,
      }
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const pathSep = process.platform === 'win32' ? ';' : ':'
    this.loopbackAuthToken = randomBytes(32).toString('hex')
    const additionalEnvVariables: Record<string, string | undefined> = {
      VIRTUAL_ENV: this.pythonEnvDir,
      PATH: [
        path.join(this.pythonEnvDir, 'bin'),
        path.join(this.pythonEnvDir, 'Scripts'),
        path.join(this.pythonEnvDir, 'Library', 'bin'),
        process.env.PATH,
        path.join(this.git.dir, 'cmd'),
      ].join(pathSep),
      PYTHONNOUSERSITE: 'true',
      PYTHONIOENCODING: 'utf-8',
      PIP_CONFIG_FILE: 'nul',
      AIPG_LOOPBACK_TOKEN: this.loopbackAuthToken,
      HF_ENDPOINT: this.settings.huggingfaceEndpoint,
    }

    const pythonBinary = path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
    const apiProcess = spawn(pythonBinary, ['web_api.py', '--port', this.port.toString()], {
      cwd: this.serviceDir,
      windowsHide: true,
      env: Object.assign(process.env, additionalEnvVariables),
    })

    const didProcessExitEarlyTracker = new Promise<boolean>((resolve, _reject) => {
      apiProcess.on('error', (error) => {
        this.appLogger.error(`encountered error of process in ${this.name} : ${error}`, this.name)
        resolve(true)
      })
      apiProcess.on('exit', () => {
        this.appLogger.error(`encountered unexpected exit in ${this.name}.`, this.name)
        resolve(true)
      })
    })

    return { process: apiProcess, didProcessExitEarlyTracker }
  }
}
