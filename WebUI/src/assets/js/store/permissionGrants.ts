import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import {
  REMOTE_DOWNLOAD_GRANT,
  VRAM_WARNING_GRANT_PREFIX,
  vramWarningGrantKey,
  type PermissionGrant,
  type PermissionGrantOrigin,
} from '@/types/permissionsIpc'
import type { IpcFail, IpcOk } from '@/types/ipcChannels'
import { extractMessage } from '@/assets/js/errors/appError'

/**
 * Renderer projection of the kernel permission-grants file (step 13). Mutations
 * write through IPC; the file in main is source of truth. Legacy
 * `memoryAlertSuppress_*` flags and a leftover Pinia persist payload migrate
 * once on `init()`.
 */

export { REMOTE_DOWNLOAD_GRANT, VRAM_WARNING_GRANT_PREFIX, vramWarningGrantKey }
export type { PermissionGrant, PermissionGrantOrigin }

const LEGACY_PERSIST_KEY = 'permissionGrants'

export type GrantBatchResult = {
  done: PermissionGrant[]
  failed: PermissionGrant[]
  error?: string
}

function withKey(
  map: Record<string, PermissionGrant>,
  key: string,
  value: PermissionGrant | undefined,
): Record<string, PermissionGrant> {
  const next = { ...map }
  if (value) next[key] = value
  else delete next[key]
  return next
}

function importLegacyMemoryAlerts(): Record<string, PermissionGrant> {
  const imported: Record<string, PermissionGrant> = {}
  try {
    if (typeof localStorage === 'undefined') return imported
    const legacyPrefix = 'memoryAlertSuppress_'
    const stale: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(legacyPrefix)) continue
      stale.push(key)
      if (localStorage.getItem(key) !== '1') continue
      const presetName = key.slice(legacyPrefix.length)
      imported[vramWarningGrantKey(presetName)] = {
        key: vramWarningGrantKey(presetName),
        origin: 'remember',
        createdAt: Date.now(),
      }
    }
    for (const key of stale) localStorage.removeItem(key)
  } catch {
    // localStorage unavailable (tests, hardened contexts): start empty.
  }
  return imported
}

function leftoverPiniaGrants(): Record<string, PermissionGrant> {
  try {
    const raw = demoAwareStorage.getItem(LEGACY_PERSIST_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as { grants?: Record<string, PermissionGrant> }
    demoAwareStorage.removeItem(LEGACY_PERSIST_KEY)
    return parsed.grants && typeof parsed.grants === 'object' ? parsed.grants : {}
  } catch {
    return {}
  }
}

export const usePermissionGrants = defineStore('permissionGrants', () => {
  const grants = ref<Record<string, PermissionGrant>>({})

  const list = computed<PermissionGrant[]>(() =>
    Object.values(grants.value).sort((a, b) => b.createdAt - a.createdAt),
  )

  function has(key: string): boolean {
    return Boolean(grants.value[key])
  }

  function setLocal(next: PermissionGrant[]): void {
    const map: Record<string, PermissionGrant> = {}
    for (const grant of next) map[grant.key] = grant
    grants.value = map
  }

  async function refresh(): Promise<void> {
    const api = window.electronAPI?.permissions
    if (!api?.list) return
    const result = await api.list()
    if (result.success) setLocal(result.grants)
  }

  async function init(): Promise<void> {
    await refresh()
    const leftover = { ...leftoverPiniaGrants(), ...importLegacyMemoryAlerts() }
    if (Object.keys(leftover).length === 0) return
    const api = window.electronAPI?.permissions
    if (!api?.migrate) {
      grants.value = { ...leftover, ...grants.value }
      return
    }
    await api.migrate(leftover)
    await refresh()
  }

  /** A failed write rolls back only its own key, so overlapping writes and refreshes survive. */
  async function writeKey(
    key: string,
    value: PermissionGrant | undefined,
    write: (() => Promise<IpcOk | IpcFail>) | undefined,
  ): Promise<IpcOk | IpcFail> {
    const previous = grants.value[key]
    grants.value = withKey(grants.value, key, value)
    if (!write) return { success: true }
    const result = await write().catch((e: unknown) => ({
      success: false as const,
      error: extractMessage(e),
    }))
    if (!result.success) grants.value = withKey(grants.value, key, previous)
    return result
  }

  function grant(key: string, origin: PermissionGrantOrigin): Promise<IpcOk | IpcFail> {
    const api = window.electronAPI?.permissions
    return writeKey(
      key,
      { key, origin, createdAt: Date.now() },
      api?.grant && (() => api.grant(key, origin)),
    )
  }

  function restore(previous: PermissionGrant): Promise<IpcOk | IpcFail> {
    const api = window.electronAPI?.permissions
    return writeKey(previous.key, previous, api?.restore && (() => api.restore(previous)))
  }

  function revoke(key: string): Promise<IpcOk | IpcFail> {
    const api = window.electronAPI?.permissions
    return writeKey(key, undefined, api?.revoke && (() => api.revoke(key)))
  }

  async function eachGrant(
    targets: PermissionGrant[],
    write: (grant: PermissionGrant) => Promise<IpcOk | IpcFail>,
  ): Promise<GrantBatchResult> {
    const batch: GrantBatchResult = { done: [], failed: [] }
    for (const target of targets) {
      const result = await write(target)
      if (result.success) batch.done.push(target)
      else {
        batch.failed.push(target)
        batch.error ??= result.error
      }
    }
    return batch
  }

  function revokeAll(targets: PermissionGrant[]): Promise<GrantBatchResult> {
    return eachGrant(targets, (target) => revoke(target.key))
  }

  function restoreAll(targets: PermissionGrant[]): Promise<GrantBatchResult> {
    return eachGrant(targets, restore)
  }

  return { grants, list, has, grant, restore, restoreAll, revoke, revokeAll, refresh, init }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePermissionGrants, import.meta.hot))
}
