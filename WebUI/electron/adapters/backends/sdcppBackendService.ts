import { execFile, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import * as filesystem from 'fs-extra'
import type { BrowserWindow } from 'electron'
import getPort from 'get-port'
import { appLoggerInstance } from '../../observability/logger.ts'
import { emitServiceUpdate } from '../../kernel/kernelBus.ts'
import type { LocalSettings } from '../../kernel/localSettings.ts'
import { fetchInstallArtifact } from '../install/fetchInstallArtifact.ts'
import { runElevatedBatch } from '../install/elevatedBatch.ts'
import {
  spawnBackend,
  terminateProcessTree,
  type ProcessSignature,
} from '../install/processLifecycle.ts'
import { extract } from '../install/tools.ts'
import { withSelectedDevice } from '../hardware/deviceDetection.ts'
import { getBundledBackendVersionSync } from '../remoteUpdates.ts'
import {
  aipgBaseDir,
  createEnhancedErrorDetails,
  type ApiService,
  type ErrorDetails,
} from './service.ts'
import * as sdcpp from './sdcppPhison.ts'

const execFileAsync = promisify(execFile)

const AUTO_DEVICE_ID = 'auto'
const HEALTH_TIMEOUT_MS = 10 * 60 * 1000
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

type ImageProcess = {
  process: ChildProcess
  models: sdcpp.SdCppImageModels
  device: string | null
  offloadPath: string | null
  port: number
  ready: boolean
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(filePath), hash)
  return hash.digest('hex')
}

async function sha256OrNull(filePath: string | null): Promise<string | null> {
  if (!filePath || !(await filesystem.pathExists(filePath))) return null
  return sha256File(filePath)
}

/**
 * The Phison sd-server package: one exe package plus the add-on for the GPU
 * vendor, unpacked into one folder. The image server is a
 * separate process started on demand with the preset's three weights.
 */
export class SdCppBackendService implements ApiService {
  readonly name: BackendServiceName
  baseUrl: string
  port: number
  readonly isRequired: boolean = false
  readonly win: BrowserWindow
  readonly settings: LocalSettings
  readonly serviceDir: string
  readonly installDir: string
  readonly addon: sdcpp.SdCppAddon = 'sycl'
  devices: InferenceDevice[] = [{ id: AUTO_DEVICE_ID, name: 'Auto select device', selected: true }]
  currentStatus: BackendStatus = 'uninitializedStatus'
  isSetUp: boolean = false
  setUpInProgress: boolean = false
  readonly appLogger = appLoggerInstance

  private part: string =
    getBundledBackendVersionSync('sdcpp-backend')?.releaseTag ?? sdcpp.SDCPP_DEFAULT_PART
  private imageProcess: ImageProcess | null = null
  private lastStartupErrorDetails: ErrorDetails | null = null
  private cachedInstalledVersion: { version: string; releaseTag?: string } | undefined

  constructor(name: BackendServiceName, port: number, win: BrowserWindow, settings: LocalSettings) {
    this.name = name
    this.port = port
    this.baseUrl = `http://127.0.0.1:${port}`
    this.win = win
    this.settings = settings
    this.serviceDir = path.resolve(path.join(aipgBaseDir(), 'sdcpp-phison'))
    this.installDir = path.join(this.serviceDir, 'server')
    this.syncSetupFlagsFromDisk()
    void this.refreshInstalledVersion().finally(() => this.updateStatus())
  }

  private get exePath(): string {
    return path.join(this.installDir, sdcpp.SDCPP_SERVER_EXE)
  }

  orphanSignatures(): ProcessSignature[] {
    return [[this.exePath]]
  }

  ownedPids(): number[] {
    const pid = this.imageProcess?.process.pid
    return pid === undefined ? [] : [pid]
  }

  private syncSetupFlagsFromDisk(): void {
    this.isSetUp = sdcpp.computeSdCppArtifactsReady(this.installDir, this.addon)
    if (
      this.currentStatus === 'uninitializedStatus' ||
      (this.isSetUp && this.currentStatus === 'notInstalled')
    ) {
      this.currentStatus = this.isSetUp ? 'notYetStarted' : 'notInstalled'
    } else if (!this.isSetUp && this.currentStatus !== 'installing') {
      this.currentStatus = 'notInstalled'
    }
  }

  private async refreshInstalledVersion(): Promise<void> {
    this.cachedInstalledVersion = await this.getInstalledVersion()
  }

  async getInstalledVersion(): Promise<{ version: string; releaseTag?: string } | undefined> {
    if (!filesystem.existsSync(this.exePath)) return undefined
    try {
      const { stdout } = await execFileAsync(this.exePath, ['--version'], {
        cwd: this.installDir,
        timeout: 30000,
        windowsHide: true,
      })
      return sdcpp.parseSdServerVersion(stdout)
    } catch (error) {
      this.appLogger.warn(`Could not read the sd-server version: ${error}`, this.name)
      return undefined
    }
  }

  get_info(): ApiServiceInformation {
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
    emitServiceUpdate(this.get_info())
  }

  async updateSettings(settings: ServiceSettings): Promise<void> {
    if (settings.releaseTag && settings.releaseTag !== this.part) {
      this.part = settings.releaseTag
      this.appLogger.info(`sd-server package set to part number ${this.part}`, this.name)
    }
  }

  async selectDevice(deviceId: string): Promise<void> {
    if (!this.devices.find((d) => d.id === deviceId)) return
    this.devices = this.devices.map((d) => ({ ...d, selected: d.id === deviceId }))
    this.updateStatus()
  }

  private selectedDeviceId(): string | null {
    const id = this.devices.find((d) => d.selected)?.id
    return id && id !== AUTO_DEVICE_ID ? id : null
  }

  async detectDevices(): Promise<void> {
    let found: { id: string; name: string }[] = []
    if (filesystem.existsSync(this.exePath)) {
      try {
        const { stdout } = await execFileAsync(this.exePath, ['--list-devices'], {
          cwd: this.installDir,
          timeout: 30000,
          windowsHide: true,
        })
        found = sdcpp.parseSdServerDevices(stdout)
      } catch (error) {
        this.appLogger.warn(`sd-server --list-devices failed: ${error}`, this.name)
      }
    }
    const choices = found.length > 0 ? found : [{ id: AUTO_DEVICE_ID, name: 'Auto select device' }]
    this.devices = withSelectedDevice(
      choices.map((d) => ({ ...d, selected: false })),
      this.settings.lastSelectedDevicePerBackend[this.name],
      (ds) => ds[0],
    )
    this.updateStatus()
  }

  async ensureBackendReadiness(): Promise<void> {}

  async start(): Promise<BackendStatus> {
    if (this.setUpInProgress) return this.currentStatus
    if (!this.isSetUp) return this.currentStatus
    this.lastStartupErrorDetails = null
    this.setStatus('running')
    return 'running'
  }

  async stop(): Promise<BackendStatus> {
    this.setStatus('stopping')
    await this.stopImageServer()
    this.setStatus('stopped')
    return 'stopped'
  }

  getImageServerUrl(): string | null {
    return this.imageProcess?.ready ? `http://127.0.0.1:${this.imageProcess.port}` : null
  }

  /** Starts sd-server for these weights, or reuses the one already serving them. */
  async startImageServer(models: sdcpp.SdCppImageModels, onProgress?: () => void): Promise<string> {
    if (this.setUpInProgress) {
      throw new Error('sd.cpp with Phison Pascari aiDAPTIV is being installed')
    }
    if (!this.isSetUp) {
      throw new Error('sd.cpp with Phison Pascari aiDAPTIV is not installed')
    }
    for (const file of [models.diffusionModel, models.vae, models.llm]) {
      if (!(await filesystem.pathExists(file))) throw new Error(`Model file not found: ${file}`)
    }
    const device = this.selectedDeviceId()
    const offloadPath = this.settings.sdcppOffloadPath
    const running = this.imageProcess
    if (
      running?.ready &&
      running.device === device &&
      running.offloadPath === offloadPath &&
      running.models.diffusionModel === models.diffusionModel &&
      running.models.vae === models.vae &&
      running.models.llm === models.llm
    ) {
      return `http://127.0.0.1:${running.port}`
    }
    await this.stopImageServer()
    await this.checkAdaDitService()
    if (this.currentStatus !== 'running') {
      this.lastStartupErrorDetails = null
      this.setStatus('running')
    }

    const port = await getPort({ port: sdcpp.sdServerPortCandidates(this.port) })
    this.port = port
    this.baseUrl = `http://127.0.0.1:${port}`
    const outputDir = path.join(this.serviceDir, 'outputs')
    // sd-server keeps its own copy of every image; the one AI Playground shows is ComfyUI's.
    await filesystem.emptyDir(outputDir)
    // sd-server refuses an --offload-path folder that does not exist yet.
    if (offloadPath) await filesystem.ensureDir(offloadPath)
    const args = sdcpp.buildSdServerArgs({
      outputDir,
      port,
      models,
      offloadPath: offloadPath ?? undefined,
      device: device ?? undefined,
    })
    this.appLogger.info(`Starting sd-server: ${args.join(' ')}`, this.name)

    const child = spawnBackend(this.exePath, args, {
      cwd: this.installDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const imageProcess: ImageProcess = {
      process: child,
      models,
      device,
      offloadPath,
      port,
      ready: false,
    }
    this.imageProcess = imageProcess
    const tail: string[] = []
    const onOutput = (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/)) {
        if (!line.trim()) continue
        this.appLogger.info(`[sd-server] ${line}`, this.name)
        tail.push(line)
        if (tail.length > 40) tail.shift()
      }
    }
    child.stdout?.on('data', onOutput)
    child.stderr?.on('data', onOutput)
    let ended = null as string | null
    child.on('error', (error) => {
      ended = `sd-server could not be started: ${error.message}`
      this.appLogger.error(ended, this.name)
      if (this.imageProcess === imageProcess) this.imageProcess = null
    })
    child.on('exit', (code) => {
      ended = `sd-server exited during start-up with code ${sdcpp.describeExitCode(code)}`
      this.appLogger.info(`sd-server exited with code ${sdcpp.describeExitCode(code)}`, this.name)
      if (this.imageProcess === imageProcess) this.imageProcess = null
    })

    try {
      await this.waitForHealth(port, () => ended, onProgress)
    } catch (error) {
      await this.terminateImageProcess(imageProcess)
      const lastOutput = tail.slice(-10).join('\n')
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}` +
          (ended && lastOutput ? `\n\nLast output from sd-server:\n${lastOutput}` : ''),
      )
    }
    imageProcess.ready = true
    this.appLogger.info(`sd-server ready on port ${port}`, this.name)
    return `http://127.0.0.1:${port}`
  }

  private async waitForHealth(
    port: number,
    ended: () => string | null,
    onProgress?: () => void,
  ): Promise<void> {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS
    while (Date.now() < deadline) {
      const reason = ended()
      if (reason) throw new Error(reason)
      let health: sdcpp.SdServerHealth | null = null
      try {
        const res = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2000),
        })
        health = sdcpp.parseSdServerHealth(res.status, await res.text())
      } catch {
        // Not listening yet.
      }
      if (health?.state === 'ok') return
      if (health?.state === 'error') {
        throw new Error(`sd-server start-up problem ${health.code}: ${health.message}`)
      }
      onProgress?.()
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    throw new Error('sd-server did not become ready within 10 minutes')
  }

  async stopImageServer(): Promise<void> {
    if (this.imageProcess) await this.terminateImageProcess(this.imageProcess)
  }

  /** Stops one launch only: a cancelled start that wakes up late must not kill its successor. */
  private async terminateImageProcess(target: ImageProcess): Promise<void> {
    if (this.imageProcess === target) this.imageProcess = null
    if (target.process.pid === undefined) return
    await terminateProcessTree(target.process, {
      name: this.name,
      label: 'sd-server',
      appLogger: this.appLogger,
    })
  }

  /** Names what is wrong with the service and how to fix it, before sd-server fails on it. */
  private async checkAdaDitService(): Promise<void> {
    if (process.platform !== 'win32') return
    const service = await this.adaDitService()
    const wanted = await sha256File(path.join(this.installDir, sdcpp.SDCPP_ADA_EXE))
    if (service?.running && (await sha256OrNull(service.binary)) === wanted) return
    const state = !service
      ? 'not installed'
      : service.running
        ? 'running another ada_dit.exe'
        : 'not running'
    throw new Error(
      `${sdcpp.SDCPP_ADA_SERVICE_NAME} is ${state}. Repair sd.cpp with ` +
        'Phison Pascari aiDAPTIV from the Setup page.',
    )
  }

  async *set_up(): AsyncIterable<SetupProgress> {
    const progress = (
      step: string,
      status: SetupProgress['status'],
      debugMessage: string,
    ): SetupProgress => ({ serviceName: this.name, step, status, debugMessage })

    this.setStatus('installing')
    let currentStep = 'start'
    try {
      yield progress(currentStep, 'executing', `setting up the Phison sd-server ${this.part}`)
      if (process.platform !== 'win32') {
        throw new Error('The Phison sd-server package runs on Windows only')
      }
      await this.stopImageServer()

      currentStep = 'download'
      yield progress(currentStep, 'executing', 'fetching the sd-server packages')
      const zips = await this.fetchPackages()

      currentStep = 'extract'
      yield progress(currentStep, 'executing', 'extracting the sd-server packages')
      await this.extractPackages(zips)

      currentStep = 'configure-ada-dit'
      yield progress(currentStep, 'executing', `checking ${sdcpp.SDCPP_ADA_SERVICE_NAME}`)
      await this.ensureAdaDitService()

      this.syncSetupFlagsFromDisk()
      if (!this.isSetUp) throw new Error(`The packages did not unpack into ${this.installDir}`)
      await this.refreshInstalledVersion()
      await this.detectDevices()
      this.setStatus('notYetStarted')
      currentStep = 'end'
      yield progress(currentStep, 'success', 'sd-server set up completely')
    } catch (e) {
      this.appLogger.warn(`Set up of the sd-server failed: ${e}`, this.name, true)
      this.syncSetupFlagsFromDisk()
      this.setStatus('installationFailed')
      yield {
        ...progress(currentStep, 'failed', `Failed to set up the Phison sd-server: ${e}`),
        errorDetails: await createEnhancedErrorDetails(e, `${currentStep} operation`),
      }
    }
  }

  /** Local paths of the exe zip and the add-on zip, taken from `sdcppPackageDir` or downloaded from S3. */
  private async fetchPackages(): Promise<string[]> {
    const files = sdcpp.sdcppPackageFiles(this.part, this.addon)
    const localDir = this.settings.sdcppPackageDir
    const zips: string[] = []
    for (const file of files) {
      const local = localDir ? path.join(localDir, file.fileName) : null
      if (local && (await filesystem.pathExists(local))) {
        this.appLogger.info(`Using ${local}`, this.name)
        await this.verifyZip(local, file, false)
        zips.push(local)
        continue
      }
      const target = path.join(this.serviceDir, file.fileName)
      await filesystem.ensureDir(this.serviceDir)
      await filesystem.remove(target)
      this.appLogger.info(`Downloading ${file.url}`, this.name)
      const response = await fetchInstallArtifact(file.url)
      if (!response.ok || !response.body) {
        throw new Error(`Failed to download ${file.fileName}: HTTP ${response.status}`)
      }
      try {
        await pipeline(
          Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
          filesystem.createWriteStream(target),
        )
      } catch (error) {
        await filesystem.remove(target)
        throw new Error(`Failed to download ${file.fileName}: ${error}`)
      }
      const expected = Number(response.headers.get('content-length'))
      const { size } = await filesystem.stat(target)
      if (Number.isFinite(expected) && expected > 0 && size !== expected) {
        await filesystem.remove(target)
        throw new Error(`Failed to download ${file.fileName}: ${size} of ${expected} bytes`)
      }
      await this.verifyZip(target, file, true)
      zips.push(target)
    }
    return zips
  }

  private async verifyZip(
    zipPath: string,
    file: sdcpp.SdCppPackageFile,
    removeOnFailure: boolean,
  ): Promise<void> {
    const fail = async (reason: string): Promise<never> => {
      if (removeOnFailure) await filesystem.remove(zipPath)
      throw new Error(`${file.fileName}: ${reason}`)
    }
    const header = Buffer.alloc(ZIP_MAGIC.length)
    const handle = await filesystem.open(zipPath, 'r')
    try {
      await filesystem.read(handle, header, 0, header.length, 0)
    } finally {
      await filesystem.close(handle)
    }
    if (!header.equals(ZIP_MAGIC)) await fail('not a zip archive')
    if (file.sha256) {
      const actual = await sha256File(zipPath)
      if (actual !== file.sha256) {
        await fail(`sha256 is ${actual}, the shipment lists ${file.sha256}`)
      }
    } else {
      this.appLogger.warn(`No pinned sha256 for ${file.fileName}`, this.name)
    }
  }

  private async extractPackages(zips: string[]): Promise<void> {
    await this.removeFolderHoldingService(this.installDir)
    await filesystem.ensureDir(this.installDir)
    for (const zip of zips) {
      await extract(zip, this.installDir)
    }
    for (const zip of zips) {
      if (path.dirname(zip) === this.serviceDir) await filesystem.remove(zip)
    }
  }

  private async adaDitService(): Promise<sdcpp.AdaDitServiceInfo | null> {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$s = Get-CimInstance Win32_Service -Filter "Name='${sdcpp.SDCPP_ADA_SERVICE_NAME}'"; ` +
          'if ($s) { $s.State; $s.PathName }',
      ],
      { windowsHide: true, timeout: 30000 },
    )
    return sdcpp.parseAdaDitServiceQuery(stdout)
  }

  /** sd-server works only with the ada_dit.exe of its own package running as the service. */
  private async ensureAdaDitService(): Promise<void> {
    const service = sdcpp.SDCPP_ADA_SERVICE_NAME
    const packaged = path.join(this.installDir, sdcpp.SDCPP_ADA_EXE)
    const wanted = await sha256File(packaged)
    const runsPackaged = async () => {
      const info = await this.adaDitService()
      return !!info?.running && (await sha256OrNull(info.binary)) === wanted
    }
    if (await runsPackaged()) {
      this.appLogger.info(`${service} already runs this ada_dit.exe`, this.name)
    } else {
      try {
        await runElevatedBatch(
          [
            `call "${path.join(this.installDir, sdcpp.SDCPP_ADA_DELETE_SCRIPT)}"`,
            sdcpp.waitForServiceRemovalCommand(service),
            `call "${path.join(this.installDir, sdcpp.SDCPP_ADA_CREATE_SCRIPT)}"`,
            sdcpp.quoteServiceBinaryCommand(service, packaged),
          ],
          this.installDir,
          { name: this.name, logger: this.appLogger },
        )
      } catch (error) {
        throw new Error(
          `${service} was not switched to the packaged ada_dit.exe: the administrator prompt ` +
            `was declined or failed (${error instanceof Error ? error.message : String(error)})`,
        )
      }
      if (!(await runsPackaged())) {
        throw new Error(`${service} does not run the packaged ada_dit.exe after the switch`)
      }
    }
    await filesystem.writeFile(path.join(this.installDir, sdcpp.SDCPP_ADA_READY_MARKER), wanted)
  }

  /** Windows will not delete ada_dit.exe while ada_dit_service runs it from this folder. */
  private async removeFolderHoldingService(dir: string): Promise<void> {
    const service = sdcpp.SDCPP_ADA_SERVICE_NAME
    const info = await this.adaDitService().catch(() => null)
    if (info?.binary && sdcpp.isInsideWindowsDir(info.binary, this.installDir)) {
      const deleteScript = path.join(this.installDir, sdcpp.SDCPP_ADA_DELETE_SCRIPT)
      try {
        await runElevatedBatch(
          [
            ...(filesystem.existsSync(deleteScript)
              ? [`call "${deleteScript}"`]
              : [`sc.exe stop ${service}`, `sc.exe delete ${service}`]),
            sdcpp.waitForServiceRemovalCommand(service),
          ],
          this.serviceDir,
          { name: this.name, logger: this.appLogger },
        )
      } catch (error) {
        // Deleting anyway takes every file but the running exe and leaves a broken install.
        throw new Error(
          `${service} runs ada_dit.exe from ${dir} and the administrator prompt to stop it was ` +
            `declined or failed, so nothing was removed ` +
            `(${error instanceof Error ? error.message : String(error)})`,
        )
      }
    }
    for (let attempt = 1; ; attempt++) {
      try {
        await filesystem.remove(dir)
        return
      } catch (error) {
        if (attempt === 5) {
          throw new Error(
            `Could not remove ${dir}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }

  async uninstall(): Promise<void> {
    await this.stop()
    await this.removeFolderHoldingService(this.serviceDir)
    this.syncSetupFlagsFromDisk()
    this.cachedInstalledVersion = undefined
    this.setStatus('notInstalled')
  }
}
