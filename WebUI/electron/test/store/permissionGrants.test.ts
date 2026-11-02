import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { PermissionGrant } from '@/types/permissionsIpc'

vi.mock('@/assets/js/demoAwareStorage', () => ({
  demoAwareStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
}))

const { usePermissionGrants } = await import('@/assets/js/store/permissionGrants')

type Result = { success: true } | { success: false; error: string }

let file: Record<string, PermissionGrant>
let failNext: boolean

function write(apply: () => void): Promise<Result> {
  if (failNext) {
    failNext = false
    return Promise.resolve({ success: false, error: 'disk full' })
  }
  apply()
  return Promise.resolve({ success: true })
}

const api = {
  list: vi.fn(async () => ({ success: true as const, grants: Object.values(file) })),
  grant: vi.fn((key: string, origin: PermissionGrant['origin']) =>
    write(() => {
      file[key] = { key, origin, createdAt: Date.now() }
    }),
  ),
  revoke: vi.fn((key: string) =>
    write(() => {
      delete file[key]
    }),
  ),
  restore: vi.fn((grant: PermissionGrant) =>
    write(() => {
      file[grant.key] = grant
    }),
  ),
  migrate: vi.fn((incoming: Record<string, PermissionGrant>) =>
    write(() => {
      for (const [key, grant] of Object.entries(incoming)) file[key] ??= grant
    }),
  ),
}

const old: PermissionGrant = { key: 'vram-warning:Big', origin: 'remember', createdAt: 1000 }
const other: PermissionGrant = { key: 'vram-warning:Huge', origin: 'remember', createdAt: 2000 }

beforeEach(async () => {
  file = { [old.key]: { ...old }, [other.key]: { ...other } }
  failNext = false
  vi.stubGlobal('window', { electronAPI: { permissions: api } })
  setActivePinia(createPinia())
  await usePermissionGrants().init()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

describe('permission grants store', () => {
  it('revokes through main and reports success', async () => {
    const grants = usePermissionGrants()
    expect((await grants.revoke(old.key)).success).toBe(true)
    expect(grants.has(old.key)).toBe(false)
    expect(file[old.key]).toBeUndefined()
  })

  it('puts a grant back and passes the error on when a revoke fails', async () => {
    const grants = usePermissionGrants()
    failNext = true
    expect(await grants.revoke(old.key)).toEqual({ success: false, error: 'disk full' })
    expect(grants.has(old.key)).toBe(true)
  })

  it('rolls back only its own key, keeping a change made meanwhile', async () => {
    const grants = usePermissionGrants()
    failNext = true
    const failing = grants.revoke(old.key)
    const meanwhile = grants.revoke(other.key)
    await Promise.all([failing, meanwhile])
    expect(grants.has(old.key)).toBe(true)
    expect(grants.has(other.key)).toBe(false)
  })

  it('drops an optimistic grant that main failed to store', async () => {
    const grants = usePermissionGrants()
    failNext = true
    expect((await grants.grant('download:remote-turns', 'pre-grant')).success).toBe(false)
    expect(grants.has('download:remote-turns')).toBe(false)
  })

  it('restores a revoked grant with its original date', async () => {
    const grants = usePermissionGrants()
    await grants.revoke(old.key)
    expect((await grants.restore(old)).success).toBe(true)
    expect(grants.grants[old.key]).toEqual(old)
    expect(file[old.key]).toEqual(old)
  })

  it('revokes all, reporting which ones main refused', async () => {
    const grants = usePermissionGrants()
    failNext = true
    const batch = await grants.revokeAll([old, other])
    expect(batch).toEqual({ done: [other], failed: [old], error: 'disk full' })
    expect(grants.has(old.key)).toBe(true)
    expect(grants.has(other.key)).toBe(false)
  })

  it('restores all, keeping the ones main refused for another try', async () => {
    const grants = usePermissionGrants()
    await grants.revokeAll([old, other])
    failNext = true
    const batch = await grants.restoreAll([old, other])
    expect(batch.done).toEqual([other])
    expect(batch.failed).toEqual([old])
  })
})
