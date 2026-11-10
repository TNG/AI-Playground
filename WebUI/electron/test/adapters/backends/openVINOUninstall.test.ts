import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { OpenVINOBackendService } from '../../../adapters/backends/openVINOBackendService'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
  BrowserWindow: class {},
  dialog: {},
}))

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovms-uninstall-'))
const serviceDir = path.join(root, 'OpenVINO')
const ovmsDir = path.join(serviceDir, 'ovms')
const pythonEnvDir = path.join(serviceDir, '.venv')

afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

// The constructor probes devices and the real install root, so only the method is exercised.
function fakeService(overrides: object = {}) {
  return Object.assign(Object.create(OpenVINOBackendService.prototype), {
    name: 'openvino-backend',
    serviceDir,
    ovmsDir,
    pythonEnvDir,
    isSetUp: true,
    appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    stop: vi.fn().mockResolvedValue('stopped'),
    setStatus: vi.fn(),
    ...overrides,
  }) as OpenVINOBackendService & { setStatus: ReturnType<typeof vi.fn> }
}

describe('OpenVINOBackendService.uninstall', () => {
  it('removes the OpenVINO .venv along with the OVMS directory', async () => {
    fs.mkdirSync(ovmsDir, { recursive: true })
    fs.mkdirSync(path.join(pythonEnvDir, 'Scripts'), { recursive: true })
    fs.writeFileSync(path.join(pythonEnvDir, 'Scripts', 'python.exe'), '')
    const service = fakeService()

    await service.uninstall()

    expect(fs.existsSync(ovmsDir)).toBe(false)
    expect(fs.existsSync(pythonEnvDir)).toBe(false)
    expect(service.isSetUp).toBe(false)
  })

  it('reports notInstalled and rethrows when a removal fails', async () => {
    const failure = new Error('EBUSY')
    const service = fakeService({ removeDirWithRetry: vi.fn().mockRejectedValue(failure) })

    await expect(service.uninstall()).rejects.toBe(failure)

    expect(service.isSetUp).toBe(false)
    expect(service.setStatus).toHaveBeenCalledWith('notInstalled')
  })
})
