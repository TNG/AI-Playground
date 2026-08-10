import { ChildProcess, execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { BrowserWindow } from 'electron'
import { LocalSettings } from '../main.ts'
import { getSharedModelDir } from '../pathsManager.ts'
import { GitService, LongLivedPythonApiService, createEnhancedErrorDetails } from './service.ts'
import {
  aipgBaseDir,
  checkBackend,
  installBackendWithExtra,
  type UvExtra,
} from './uvBasedBackends/uv.ts'
import { levelZeroDeviceSelectorEnv, withSelectedDevice } from './deviceDetection.ts'

const execFileAsync = promisify(execFile)

/**
 * Standalone Whisper speech-to-text sidecar. Runs Whisper on torch (Intel XPU /
 * NVIDIA CUDA / CPU) via transformers, so it works in every product mode — unlike
 * the OVMS Whisper engine, which needs OpenVINO. Mirrors {@link Qwen3TtsBackendService}.
 */
export class WhisperBackendService extends LongLivedPythonApiService {
  readonly serviceFolder = 'whisper-backend'
  readonly baseDir = path.resolve(path.join(aipgBaseDir, this.serviceFolder))
  readonly serviceDir = this.baseDir
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: 'cpu', name: 'CPU', selected: true }]
  private devicesDetected = false
  readonly git = new GitService()

  isSetUp: boolean = false
  readonly isRequired = false
  healthEndpointUrl = `${this.baseUrl}/healthy`

  private loopbackAuthToken: string = randomBytes(32).toString('hex')

  getLoopbackAuthToken(): string {
    return this.loopbackAuthToken
  }

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

  /** CUDA in NVIDIA product mode, Intel XPU on Windows, CPU elsewhere. */
  private get torchExtra(): UvExtra {
    if (this.settings.productMode === 'nvidia') return 'cuda'
    if (process.platform === 'win32') return 'xpu'
    return 'cpu'
  }

  async serviceIsSetUp(): Promise<boolean> {
    const result = await checkBackend(this.serviceFolder, this.torchExtra)
      .then(() => true)
      .catch(() => false)
    this.appLogger.info(`Service ${this.name} isSetUp: ${result}`, this.name)
    return result
  }

  private get pythonBinary(): string {
    return path.join(
      this.pythonEnvDir,
      process.platform === 'win32' ? 'Scripts' : 'bin',
      process.platform === 'win32' ? 'python.exe' : 'python',
    )
  }

  private get venvProcessEnv(): Record<string, string | undefined> {
    const pathSep = process.platform === 'win32' ? ';' : ':'
    return {
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
    }
  }

  /** Enumerate torch accelerators (XPU / CUDA / CPU) via list_devices.py. */
  async detectDevices(): Promise<void> {
    const cpuDevice: InferenceDevice = { id: 'cpu', name: 'CPU', selected: false }
    let available: InferenceDevice[] = [{ ...cpuDevice }]
    try {
      if (this.isSetUp) {
        const { stdout, stderr } = await execFileAsync(this.pythonBinary, ['list_devices.py'], {
          cwd: this.serviceDir,
          env: {
            ...process.env,
            ...this.venvProcessEnv,
            ...levelZeroDeviceSelectorEnv('*'),
            SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
            SYCL_CACHE_PERSISTENT: '1',
          },
          timeout: 30000,
        })
        if (stderr.trim()) this.appLogger.info(`device probe: ${stderr.trim()}`, this.name)
        const probed = JSON.parse(stdout.trim()) as Array<{ id: string; name: string }>
        if (probed.length > 0) available = probed.map((d) => ({ ...d, selected: false }))
        this.appLogger.info(`detected Whisper devices: ${JSON.stringify(probed)}`, this.name)
      }
    } catch (e) {
      this.appLogger.warn(`whisper device detection failed, defaulting to CPU: ${e}`, this.name)
      available = [{ ...cpuDevice }]
    }
    this.devices = withSelectedDevice(
      available,
      this.settings.lastSelectedDevicePerBackend[this.name],
      (ds) => ds[0],
    )
    if (this.isSetUp) this.devicesDetected = true
    this.updateStatus()
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up whisper service', this.name)

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up environment',
      }

      await this.git.ensureInstalled()

      currentStep = 'install dependencies'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing dependencies (torch may take several minutes)',
      }

      this.appLogger.info(`installing whisper with torch extra '${this.torchExtra}'`, this.name)
      await installBackendWithExtra(this.serviceFolder, this.torchExtra)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'dependencies installed',
      }

      this.isSetUp = true
      this.devicesDetected = false
      await this.detectDevices()

      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: 'whisper service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of whisper failed due to ${e}`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup python environment due to ${e}`,
        errorDetails,
      }
    }
  }

  /**
   * Env pointing the engine at the shared STT model dir (so it can resolve the
   * per-repo local weights the download popup writes there) plus HF offline so the
   * sidecar never silently downloads — installs go through the popup only.
   */
  private get modelPathEnv(): Record<string, string> {
    const env: Record<string, string> = { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' }
    const sttDir = getSharedModelDir('STT')
    if (sttDir) env.WHISPER_MODEL_DIR = sttDir
    return env
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    this.loopbackAuthToken = randomBytes(32).toString('hex')
    if (!this.devicesDetected) await this.detectDevices()
    const selectedDevice = this.devices.find((d) => d.selected)?.id ?? 'cpu'
    const deviceEnv: Record<string, string> =
      selectedDevice === 'auto' ? {} : { WHISPER_DEVICE: selectedDevice }
    this.appLogger.info(`starting whisper on device: ${selectedDevice}`, this.name)
    const additionalEnvVariables: Record<string, string | undefined> = {
      ...this.venvProcessEnv,
      PIP_CONFIG_FILE: process.platform === 'win32' ? 'nul' : '/dev/null',
      AIPG_LOOPBACK_TOKEN: this.loopbackAuthToken,
      SYCL_ENABLE_DEFAULT_CONTEXTS: '1',
      SYCL_CACHE_PERSISTENT: '1',
      ...levelZeroDeviceSelectorEnv('*'),
      ...this.modelPathEnv,
      ...deviceEnv,
    }

    const apiProcess = spawn(this.pythonBinary, ['web_api.py', '--port', this.port.toString()], {
      cwd: this.serviceDir,
      windowsHide: true,
      env: { ...process.env, ...additionalEnvVariables },
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

    return {
      process: apiProcess,
      didProcessExitEarlyTracker,
    }
  }
}
