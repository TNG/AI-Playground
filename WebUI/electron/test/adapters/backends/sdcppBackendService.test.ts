import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { ChildProcess } from 'node:child_process'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { LocalSettingsSchema } from '../../../kernel/localSettings'
import { SdCppBackendService } from '../../../adapters/backends/sdcppBackendService'
import { computeSdCppArtifactsReady } from '../../../adapters/backends/sdcppPhison'
import { spawnBackend, terminateProcessTree } from '../../../adapters/install/processLifecycle'
import { runElevatedBatch } from '../../../adapters/install/elevatedBatch'
import { fetchInstallArtifact } from '../../../adapters/install/fetchInstallArtifact'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), getVersion: () => '0.0.0' },
  net: { fetch: vi.fn() },
}))

// The service writes under aipgBaseDir(); keep that out of the checkout the tests run in.
vi.mock('../../../adapters/backends/service', async (importOriginal) => {
  const fs = await import('node:fs')
  const nodeOs = await import('node:os')
  const nodePath = await import('node:path')
  const baseDir = fs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'sdcpp-base-'))
  return {
    ...(await importOriginal<typeof import('../../../adapters/backends/service')>()),
    aipgBaseDir: () => baseDir,
  }
})

vi.mock('../../../adapters/install/elevatedBatch', () => ({ runElevatedBatch: vi.fn() }))

vi.mock('../../../adapters/install/fetchInstallArtifact', () => ({
  fetchInstallArtifact: vi.fn(async () => new Response(null, { status: 404 })),
}))

vi.mock('../../../adapters/install/processLifecycle', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../adapters/install/processLifecycle')>()),
  spawnBackend: vi.fn(),
  terminateProcessTree: vi.fn(async (proc: EventEmitter & { exitCode: number | null }) => {
    proc.exitCode = 1
    proc.emit('exit', 1)
  }),
}))

type FakeChild = EventEmitter & {
  pid: number | undefined
  stdout: EventEmitter
  stderr: EventEmitter
  exitCode: number | null
  signalCode: NodeJS.Signals | null
}

function fakeChild(pid: number | undefined): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    exitCode: null,
    signalCode: null,
  })
}

const tempDirs: string[] = []

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

afterAll(() => {
  rmSync(path.dirname(service().serviceDir), { recursive: true, force: true })
})

function service(overrides: Record<string, unknown> = {}) {
  const settings = LocalSettingsSchema.parse(overrides)
  return new SdCppBackendService('sdcpp-backend', 46000, {} as BrowserWindow, settings)
}

async function lastProgress(svc: SdCppBackendService): Promise<SetupProgress> {
  let last: SetupProgress | undefined
  for await (const update of svc.set_up()) last = update
  return last!
}

describe('SdCppBackendService', () => {
  it('reports itself as sdcpp-backend and reads isSetUp from the install folder', () => {
    const svc = service()
    const info = svc.get_info()
    expect(info.serviceName).toBe('sdcpp-backend')
    expect(info.isSetUp).toBe(computeSdCppArtifactsReady(svc.installDir))
  })

  it.runIf(process.platform === 'win32')(
    'downloads the host zip from the S3 bucket when no local folder is set',
    async () => {
      const result = await lastProgress(service())
      expect(vi.mocked(fetchInstallArtifact)).toHaveBeenCalledWith(
        'https://phisonbucket.s3.ap-northeast-1.amazonaws.com/NXWIH602T2_x64.zip',
      )
      expect(result.status).toBe('failed')
      expect(result.step).toBe('download')
      expect(result.debugMessage).toContain('NXWIH602T2_x64.zip: HTTP 404')
    },
  )

  it.runIf(process.platform === 'win32')(
    'refuses a local zip whose sha256 is not the one the shipment lists',
    async () => {
      const dir = mkdtempSync(path.join(os.tmpdir(), 'sdcpp-packages-'))
      tempDirs.push(dir)
      writeFileSync(
        path.join(dir, 'NXWIH602T2_x64.zip'),
        Buffer.from('PK\u0003\u0004 not the shipment'),
      )
      const result = await lastProgress(service({ sdcppPackageDir: dir }))
      expect(result.status).toBe('failed')
      expect(result.debugMessage).toContain('sha256')
    },
  )
})

describe('SdCppBackendService folder removal', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it.runIf(process.platform === 'win32')(
    'leaves the install alone when the prompt to stop ada_dit_service is declined',
    async () => {
      const svc = service()
      const adaDit = path.join(svc.installDir, 'ada_dit.exe')
      const serverExe = path.join(svc.installDir, 'sd-server.exe')
      mkdirSync(svc.installDir, { recursive: true })
      writeFileSync(adaDit, '')
      writeFileSync(serverExe, '')
      vi.spyOn(
        SdCppBackendService.prototype as unknown as { adaDitService(): Promise<unknown> },
        'adaDitService',
      ).mockResolvedValue({ running: true, binary: adaDit })
      vi.mocked(runElevatedBatch).mockRejectedValueOnce(
        new Error('Failed to run elevated batch: Command failed'),
      )
      const removeFolder = (
        svc as unknown as { removeFolderHoldingService(dir: string): Promise<void> }
      ).removeFolderHoldingService.bind(svc)
      await expect(removeFolder(svc.installDir)).rejects.toThrow('nothing was removed')
      expect(existsSync(serverExe)).toBe(true)
    },
  )
})

describe('SdCppBackendService.startImageServer', () => {
  let models: { diffusionModel: string; vae: string; llm: string }
  let health: () => Response

  beforeEach(() => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'sdcpp-weights-'))
    tempDirs.push(dir)
    models = {
      diffusionModel: path.join(dir, 'd.gguf'),
      vae: path.join(dir, 'v.safetensors'),
      llm: path.join(dir, 'l.safetensors'),
    }
    for (const file of Object.values(models)) writeFileSync(file, '')
    vi.mocked(spawnBackend).mockReset()
    vi.mocked(terminateProcessTree).mockClear()
    vi.spyOn(
      SdCppBackendService.prototype as unknown as { checkAdaDitService(): Promise<void> },
      'checkAdaDitService',
    ).mockResolvedValue()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => health()),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  function installedService() {
    const svc = service()
    svc.isSetUp = true
    return svc
  }

  const healthy = () => new Response('{"status":"ok","device":"SYCL0"}', { status: 200 })

  it('marks the component running when a generation starts the server', async () => {
    vi.mocked(spawnBackend).mockReturnValueOnce(fakeChild(101) as unknown as ChildProcess)
    health = healthy
    const svc = installedService()
    svc.currentStatus = 'stopped'
    await expect(svc.startImageServer(models)).resolves.toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(svc.currentStatus).toBe('running')
  })

  it('reports a start-up problem with its code and sentence, and stops that server', async () => {
    const child = fakeChild(102)
    vi.mocked(spawnBackend).mockReturnValueOnce(child as unknown as ChildProcess)
    health = () =>
      new Response(
        '{"status":"error","error":{"code":"example_failure","message":"Something went wrong."}}',
        { status: 503 },
      )
    await expect(installedService().startImageServer(models)).rejects.toThrow(
      'sd-server start-up problem example_failure: Something went wrong.',
    )
    expect(terminateProcessTree).toHaveBeenCalledWith(child, expect.anything())
  })

  it('fails with the spawn error instead of waiting for a process that never started', async () => {
    const child = fakeChild(undefined)
    vi.mocked(spawnBackend).mockImplementationOnce(() => {
      process.nextTick(() => child.emit('error', new Error('spawn sd-server.exe ENOENT')))
      return child as unknown as ChildProcess
    })
    health = () => {
      throw new TypeError('fetch failed')
    }
    await expect(installedService().startImageServer(models)).rejects.toThrow(
      'sd-server could not be started: spawn sd-server.exe ENOENT',
    )
    expect(terminateProcessTree).not.toHaveBeenCalled()
  })

  it('does not let a cancelled start that wakes up late stop the server that replaced it', async () => {
    const first = fakeChild(103)
    const second = fakeChild(104)
    vi.mocked(spawnBackend)
      .mockReturnValueOnce(first as unknown as ChildProcess)
      .mockReturnValueOnce(second as unknown as ChildProcess)
    let ready = false
    health = () => (ready ? healthy() : new Response('{"status":"loading"}', { status: 503 }))
    const svc = installedService()
    const firstStart = svc.startImageServer(models)
    await vi.waitFor(() => expect(spawnBackend).toHaveBeenCalledTimes(1))
    const secondStart = svc.startImageServer(models)
    await expect(firstStart).rejects.toThrow('exited during start-up')
    ready = true
    const url = await secondStart
    expect(terminateProcessTree).not.toHaveBeenCalledWith(second, expect.anything())
    expect(svc.getImageServerUrl()).toBe(url)
  }, 15000)
})
