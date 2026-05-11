import { ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { GitService, LongLivedPythonApiService, createEnhancedErrorDetails } from './service.ts'
import { aipgBaseDir, checkBackend, installBackend } from './uvBasedBackends/uv.ts'
import { app, BrowserWindow, net, safeStorage } from 'electron'
import { LocalSettings } from '../main.ts'

export class HomeAgentBackendService extends LongLivedPythonApiService {
  isSetUp: boolean = false

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

  readonly serviceFolder = 'home-agent'
  readonly baseDir = path.resolve(path.join(aipgBaseDir, this.serviceFolder))
  readonly serviceDir = this.baseDir
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()

  readonly isRequired = false
  healthEndpointUrl = `${this.baseUrl}/healthy`

  async serviceIsSetUp() {
    const result = await checkBackend('home-agent')
      .then(() => true)
      .catch(() => false)
    this.appLogger.info(`Service ${this.name} isSetUp: ${result}`, this.name)
    return result
  }

  async detectDevices() {}

  async setUpstreamUrl(url: string): Promise<void> {
    try {
      await net.fetch(`${this.baseUrl}/set-upstream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
    } catch (e) {
      this.appLogger.warn(`Failed to set upstream URL for home-agent: ${e}`, this.name)
    }
  }

  private readTelegramConfig(): { token: string; chatId: string } | null {
    try {
      const configPath = path.join(app.getPath('userData'), 'home-agent-config.json')
      const raw = fs.readFileSync(configPath, 'utf-8')
      const data = JSON.parse(raw) as { encryptedToken: { type: string; data: number[] }; chatId: string }
      const buf = Buffer.from(data.encryptedToken.data)
      const token = safeStorage.decryptString(buf)
      return { token, chatId: data.chatId ?? '' }
    } catch {
      return null
    }
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    this.appLogger.info('setting up home-agent service', this.name)

    let currentStep = 'start'

    try {
      currentStep = 'start'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up home-agent environment',
      }

      await this.git.ensureInstalled()

      currentStep = 'install dependencies'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing dependencies',
      }

      await installBackend(this.serviceFolder)

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
        debugMessage: 'home-agent service set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of home-agent service failed due to ${e}`, this.name, true)
      this.setStatus('installationFailed')

      const errorDetails = await createEnhancedErrorDetails(e, `${currentStep} operation`)

      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to setup home-agent environment due to ${e}`,
        errorDetails,
      }
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const telegramConfig = this.readTelegramConfig()
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
    }
    if (telegramConfig?.token) {
      additionalEnvVariables['TELEGRAM_BOT_TOKEN'] = telegramConfig.token
      if (telegramConfig.chatId) {
        additionalEnvVariables['TELEGRAM_CHAT_ID'] = telegramConfig.chatId
      }
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
        this.appLogger.error(
          `encountered error of process in ${this.name} : ${error}`,
          this.name,
        )
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

