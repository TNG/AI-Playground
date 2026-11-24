import { ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { app, BrowserWindow } from 'electron'
import getPort, { portNumbers } from 'get-port'
import type { LocalSettings } from '../../kernel/localSettings.ts'
import { GitService, LongLivedPythonApiService, createEnhancedErrorDetails } from './service.ts'
import { aipgBaseDir, syncUpstreamProject, venvIsUsable } from '../install/uvBasedBackends/uv.ts'
import {
  spawnBackend,
  terminateProcessTree,
  type ProcessSignature,
} from '../install/processLifecycle.ts'
import { getBundledBackendVersionSync } from '../remoteUpdates.ts'
import {
  buildHermesConfig,
  buildHermesEnv,
  HERMES_MIN_CONTEXT,
  type HermesEndpoint,
} from './hermesConfig.ts'

const HERMES_REMOTE = 'https://github.com/NousResearch/hermes-agent.git'
const HERMES_PYTHON = '3.14'
const DASHBOARD_READY_TIMEOUT_MS = 5 * 60_000

/** Where AIPG's own endpoints are, for Hermes to call back into. Set by the integration wiring. */
export type HermesIntegrationEndpoints = { llm: HermesEndpoint; mcp?: HermesEndpoint }

export type HermesRunSettings = { workspaceDir?: string; contextLength?: number }

export class HermesBackendService extends LongLivedPythonApiService {
  readonly serviceFolder = 'hermes-agent'
  readonly serviceDir = path.resolve(path.join(aipgBaseDir, this.serviceFolder))
  readonly pythonEnvDir = path.resolve(path.join(this.serviceDir, '.venv'))
  /** Kept apart from `~/.hermes` / `%LOCALAPPDATA%\hermes`, so a Hermes the user runs themselves is never touched. */
  readonly hermesHome = path.join(app.getPath('userData'), 'hermes')
  devices: InferenceDevice[] = [{ id: '*', name: 'Auto select device', selected: true }]
  readonly git = new GitService()
  isSetUp = false
  readonly isRequired = false
  healthEndpointUrl = `${this.baseUrl}/health`

  private apiKey = randomBytes(32).toString('hex')
  private endpoints: HermesIntegrationEndpoints | null = null
  private endpointProvider: (() => Promise<HermesIntegrationEndpoints>) | null = null
  private dashboard: { process: ChildProcess; url: string } | null = null
  private dashboardStarting: Promise<string> | null = null

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    super(name, port, win, settings)
    void this.publishInitialSetupStatus()
  }

  get revision(): string {
    return getBundledBackendVersionSync('hermes-backend')?.version ?? 'main'
  }

  get hermesBin(): string {
    return process.platform === 'win32'
      ? path.join(this.pythonEnvDir, 'Scripts', 'hermes.exe')
      : path.join(this.pythonEnvDir, 'bin', 'hermes')
  }

  /** Bearer key for the gateway's API server; rotated on every spawn. */
  getApiKey(): string {
    return this.apiKey
  }

  /** AIPG's proxy and MCP server start lazily, the first time the gateway needs them. */
  setIntegrationProvider(provider: () => Promise<HermesIntegrationEndpoints>): void {
    this.endpointProvider = provider
  }

  private async resolveEndpoints(): Promise<void> {
    if (!this.endpoints && this.endpointProvider) this.endpoints = await this.endpointProvider()
  }

  orphanSignatures(): ProcessSignature[] {
    return [
      [this.hermesBin, 'gateway'],
      [this.hermesBin, 'dashboard'],
    ]
  }

  ownedPids(): number[] {
    return [this.encapsulatedProcess?.pid, this.dashboard?.process.pid].filter(
      (pid): pid is number => pid !== undefined,
    )
  }

  async serviceIsSetUp(): Promise<boolean> {
    const result = fs.existsSync(this.hermesBin) && venvIsUsable(this.pythonEnvDir)
    this.appLogger.info(`Service ${this.name} isSetUp: ${result}`, this.name)
    return result
  }

  async detectDevices(): Promise<void> {}

  async getInstalledVersion(): Promise<{ version: string } | undefined> {
    if (!fs.existsSync(path.join(this.serviceDir, '.git'))) return undefined
    try {
      const head = await this.git.run(['-C', this.serviceDir, 'rev-parse', 'HEAD'])
      return { version: head.trim().slice(0, 12) }
    } catch {
      return undefined
    }
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    this.setStatus('installing')
    let currentStep = 'start'
    try {
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'starting to set up Hermes Agent',
      }
      await this.git.ensureInstalled()

      currentStep = 'install hermes'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: `fetching hermes-agent ${this.revision}`,
      }
      await this.checkoutPinnedRevision()

      currentStep = 'install dependencies'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'executing',
        debugMessage: 'installing Python 3.14 and Hermes dependencies',
      }
      await this.prepareCleanPythonEnv()
      await syncUpstreamProject(this.serviceDir, { python: HERMES_PYTHON, extras: ['all'] })
      await this.updateCachedVersion()

      this.isSetUp = true
      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'success',
        debugMessage: 'Hermes Agent set up completely',
      }
    } catch (e) {
      this.appLogger.warn(`Set up of Hermes Agent failed due to ${e}`, this.name, true)
      this.setStatus('installationFailed')
      yield {
        serviceName: this.name,
        step: currentStep,
        status: 'failed',
        debugMessage: `Failed to set up Hermes Agent due to ${e}`,
        errorDetails: await createEnhancedErrorDetails(e, `${currentStep} operation`),
      }
    }
  }

  private async checkoutPinnedRevision(): Promise<void> {
    const gitDir = path.join(this.serviceDir, '.git')
    if (!fs.existsSync(gitDir)) {
      fs.rmSync(this.serviceDir, { recursive: true, force: true })
      await this.git.run(['clone', '--filter=blob:none', HERMES_REMOTE, this.serviceDir])
    } else {
      await this.git.run(['-C', this.serviceDir, 'fetch', 'origin'])
    }
    await this.git.run(['-C', this.serviceDir, 'checkout', '--force', this.revision])
  }

  /** Rewrites `config.yaml`; Hermes reads it per run, so a turn can set its own workspace. */
  writeRuntimeConfig(run: HermesRunSettings = {}): void {
    if (!this.endpoints) throw new Error('Hermes integration endpoints are not configured')
    fs.mkdirSync(this.hermesHome, { recursive: true })
    const config = buildHermesConfig({
      llm: this.endpoints.llm,
      mcp: this.endpoints.mcp,
      contextLength: run.contextLength ?? HERMES_MIN_CONTEXT * 2,
      workspaceDir: run.workspaceDir,
    })
    fs.writeFileSync(path.join(this.hermesHome, 'config.yaml'), JSON.stringify(config, null, 2))
  }

  private childEnv(): NodeJS.ProcessEnv {
    const pathSep = process.platform === 'win32' ? ';' : ':'
    return {
      ...process.env,
      HERMES_HOME: this.hermesHome,
      VIRTUAL_ENV: this.pythonEnvDir,
      PATH: [
        path.join(this.pythonEnvDir, process.platform === 'win32' ? 'Scripts' : 'bin'),
        process.env.PATH,
        path.join(this.git.dir, 'cmd'),
      ].join(pathSep),
      PYTHONNOUSERSITE: 'true',
      PYTHONIOENCODING: 'utf-8',
      HF_HUB_OFFLINE: '1',
    }
  }

  async spawnAPIProcess(): Promise<{
    process: ChildProcess
    didProcessExitEarlyTracker: Promise<boolean>
  }> {
    this.apiKey = randomBytes(32).toString('hex')
    await this.resolveEndpoints()
    fs.mkdirSync(this.hermesHome, { recursive: true })
    fs.writeFileSync(path.join(this.hermesHome, '.env'), buildHermesEnv(this.port, this.apiKey))
    this.writeRuntimeConfig()

    const apiProcess = spawnBackend(this.hermesBin, ['gateway', 'run'], {
      cwd: this.hermesHome,
      env: this.childEnv(),
    })
    const didProcessExitEarlyTracker = new Promise<boolean>((resolve) => {
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

  /** Starts `hermes dashboard` on first use; its first launch builds the web UI, which takes a while. */
  async ensureDashboard(): Promise<string> {
    if (this.dashboard && this.dashboard.process.exitCode === null) return this.dashboard.url
    this.dashboardStarting ??= this.startDashboard().finally(() => {
      this.dashboardStarting = null
    })
    return this.dashboardStarting
  }

  private async startDashboard(): Promise<string> {
    if (!(await this.serviceIsSetUp())) throw new Error('Hermes Agent is not installed')
    await this.resolveEndpoints()
    this.writeRuntimeConfig()
    const port = await getPort({ port: portNumbers(19100, 19199) })
    const url = `http://127.0.0.1:${port}`
    const child = spawnBackend(
      this.hermesBin,
      ['dashboard', '--no-open', '--host', '127.0.0.1', '--port', String(port)],
      { cwd: this.hermesHome, env: this.childEnv() },
    )
    child.stdout?.on('data', (data: Buffer) =>
      this.appLogger.info(`dashboard: ${data.toString().trim()}`, this.name),
    )
    child.stderr?.on('data', (data: Buffer) =>
      this.appLogger.warn(`dashboard: ${data.toString().trim()}`, this.name),
    )
    this.dashboard = { process: child, url }
    const deadline = Date.now() + DASHBOARD_READY_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error('Hermes dashboard exited during startup')
      try {
        if ((await fetch(url, { signal: AbortSignal.timeout(2000) })).ok) return url
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    await this.stopDashboard()
    throw new Error('Hermes dashboard did not start in time')
  }

  private async stopDashboard(): Promise<void> {
    const dashboard = this.dashboard
    this.dashboard = null
    if (dashboard) {
      await terminateProcessTree(dashboard.process, { name: this.name, appLogger: this.appLogger })
    }
  }

  async stop(): Promise<BackendStatus> {
    await this.stopDashboard()
    return super.stop()
  }
}
