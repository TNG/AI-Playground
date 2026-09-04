import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

// The window loads (and initSetup runs) while the service registry is still
// being built. In the kernel world the renderer buffers stream events during
// the snapshot handshake and applies them once the snapshot installs — so a
// push that raced the handshake must survive an empty snapshot, and boot must
// not treat the still-pending state as fatal.

const AI_BACKEND = {
  serviceName: 'ai-backend',
  isSetUp: true,
  status: 'notYetStarted',
  baseUrl: 'http://127.0.0.1:59000',
  isRequired: true,
  devices: [],
}

let pushKernelEvent: (event: unknown) => void = () => {}
let resolveSnapshot: (snapshot: unknown) => void

const getKernelSnapshot = vi.fn(
  () =>
    new Promise<unknown>((resolve) => {
      resolveSnapshot = resolve
    }),
)

vi.stubGlobal('window', {
  electronAPI: {
    getServices: vi.fn(async () => []),
    getInitSetting: vi.fn(async () => ({
      modelLists: { embedding: [] },
      modelPaths: {},
      version: '0.0.0',
      modelFolderReadOnly: false,
    })),
    onKernelEvent: vi.fn((cb: (event: unknown) => void) => {
      pushKernelEvent = cb
      return () => {}
    }),
    getKernelSnapshot,
    onServiceSetUpProgress: vi.fn(),
    getComfyUiDefaultParameters: vi.fn(async () => ''),
    getLlamaCppDefaultParameters: vi.fn(async () => ''),
    resolveBackendVersion: vi.fn(async () => ({ version: '1.0.0' })),
    detectPhisonSsd: vi.fn(async () => ({ detected: false })),
  },
})

vi.mock('@/lib/loopbackAuth', () => ({
  invalidateBackendAuthToken: vi.fn(),
  getBackendAuthToken: vi.fn(async () => 'token'),
}))

vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({
    initPaths: vi.fn(),
  }),
}))

function serviceEvent(info: unknown, seq: number) {
  return { type: 'service', info, scope: { kind: 'global' }, seq }
}

beforeEach(() => {
  setActivePinia(createPinia())
  getKernelSnapshot.mockClear()
  getKernelSnapshot.mockImplementation(
    () =>
      new Promise<unknown>((resolve) => {
        resolveSnapshot = resolve
      }),
  )
})

describe('backend init race', () => {
  it('applies a push that raced the handshake once the snapshot installs', async () => {
    const { useBackendServices } = await import('@/assets/js/store/backendServices')
    const store = useBackendServices()

    // Buffered while the snapshot request is in flight...
    pushKernelEvent(serviceEvent(AI_BACKEND, 1))
    expect(store.info.length).toBe(0)

    // ...and applied once an empty snapshot installs at sequence 0.
    resolveSnapshot({
      scope: { kind: 'global' },
      sequence: 0,
      state: { services: [], activeTurn: null },
    })
    await vi.waitFor(() => expect(store.info.length).toBeGreaterThan(0))
    expect(store.info.some((s) => s.serviceName === 'ai-backend')).toBe(true)
  })

  it('drops a push the snapshot already contains, without losing the service', async () => {
    const { useBackendServices } = await import('@/assets/js/store/backendServices')
    const store = useBackendServices()

    pushKernelEvent(serviceEvent(AI_BACKEND, 1))
    resolveSnapshot({
      scope: { kind: 'global' },
      sequence: 1,
      state: { services: [AI_BACKEND], activeTurn: null },
    })
    await vi.waitFor(() => expect(store.info.length).toBeGreaterThan(0))
    // Applied exactly once — from the snapshot, not double-upserted.
    expect(store.info.filter((s) => s.serviceName === 'ai-backend')).toHaveLength(1)
  })

  it('initSetup succeeds from the store when hydration came from the stream', async () => {
    const { useBackendServices } = await import('@/assets/js/store/backendServices')
    const { useGlobalSetup } = await import('@/assets/js/store/globalSetup')
    const backendServices = useBackendServices()
    const globalSetup = useGlobalSetup()

    pushKernelEvent(serviceEvent(AI_BACKEND, 1))
    resolveSnapshot({
      scope: { kind: 'global' },
      sequence: 0,
      state: { services: [], activeTurn: null },
    })
    await vi.waitFor(() =>
      expect(backendServices.info.some((s) => s.serviceName === 'ai-backend')).toBe(true),
    )

    await globalSetup.initSetup()

    expect(globalSetup.apiHost).toBe('http://127.0.0.1:59000')
  })
})
