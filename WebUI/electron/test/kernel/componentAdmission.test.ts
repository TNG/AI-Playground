import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendServiceName } from '@/assets/js/store/backendServices'
import type { HeldComponent } from '@/types/componentChange'

vi.mock('electron', () => ({
  app: { isPackaged: false, getVersion: () => '0.0.0-test' },
  shell: {},
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  nativeImage: {},
  BrowserWindow: class {},
  dialog: {},
  net: {},
  screen: {},
}))

const { buildCoreInvokeRegistry } = await import('../../kernel/registries/core')
const { createComponentChanges } = await import('../../kernel/componentChanges')

function setup(held: () => HeldComponent[], isRequired = false) {
  const setUp = vi.fn(async function* () {
    yield { status: 'success' as const }
  })
  const stop = vi.fn(async () => 'stopped')
  const uninstall = vi.fn(async () => {})
  const service = {
    serviceName: 'llamacpp-backend' as BackendServiceName,
    isRequired,
    setUpInProgress: false,
    set_up: setUp,
    stop,
    uninstall,
    updateSettings: vi.fn(),
  }
  const componentChanges = createComponentChanges({
    heldComponents: held,
    hasInFlightWork: () => false,
  })
  const registry = buildCoreInvokeRegistry({
    getServiceRegistry: () => ({ getService: () => service }),
    getWin: () => ({ webContents: { send: vi.fn() } }),
    appLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    componentChanges,
  } as never)
  const invoke = <T>(name: string, serviceName: string) =>
    (registry as unknown as Record<string, (event: unknown, name: string) => Promise<T> | T>)[name](
      {},
      serviceName,
    )
  return { setUp, stop, uninstall, invoke }
}

describe('Component admission in the kernel handlers', () => {
  let held: HeldComponent[]

  beforeEach(() => {
    held = []
  })

  it('refuses setUpService for a held Component without stopping or installing it', async () => {
    held = [{ component: 'llamacpp-backend', work: 'turn' }]
    const { setUp, stop, invoke } = setup(() => held)

    const result = await invoke<{ success: boolean; refusal?: { work: string } }>(
      'setUpService',
      'llamacpp-backend',
    )

    expect(result).toMatchObject({ success: false, refusal: { work: 'turn' } })
    expect(stop).not.toHaveBeenCalled()
    expect(setUp).not.toHaveBeenCalled()
  })

  it('refuses uninstall for a held Component without stopping or removing it', async () => {
    held = [{ component: 'llamacpp-backend', work: 'media-run' }]
    const { stop, uninstall, invoke } = setup(() => held)

    const result = await invoke<{ success: boolean; refusal?: { work: string } }>(
      'uninstall',
      'llamacpp-backend',
    )

    expect(result).toMatchObject({ success: false, refusal: { work: 'media-run' } })
    expect(stop).not.toHaveBeenCalled()
    expect(uninstall).not.toHaveBeenCalled()
  })

  it('answers the admission query the renderer asks before stopping anything', async () => {
    held = [{ component: 'llamacpp-backend', work: 'agent-run' }]
    const { stop, invoke } = setup(() => held)

    const refused = await invoke<{ success: boolean; refusal?: { work: string } }>(
      'componentChangeAdmission',
      'llamacpp-backend',
    )
    expect(refused).toMatchObject({ success: false, refusal: { work: 'agent-run' } })
    expect(stop).not.toHaveBeenCalled()

    held = []
    const allowed = await invoke<{ success: boolean }>(
      'componentChangeAdmission',
      'llamacpp-backend',
    )
    expect(allowed.success).toBe(true)
  })

  it('still refuses a required Component through the uninstall handler', async () => {
    const { uninstall, invoke } = setup(() => held, true)

    const result = await invoke<{ success: boolean; error: string }>(
      'uninstall',
      'llamacpp-backend',
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/required/)
    expect(uninstall).not.toHaveBeenCalled()
  })

  it('lets the change through once the work ends', async () => {
    const { setUp, invoke } = setup(() => held)

    const result = await invoke<{ success: boolean }>('setUpService', 'llamacpp-backend')

    expect(result.success).toBe(true)
    expect(setUp).toHaveBeenCalled()
  })
})
