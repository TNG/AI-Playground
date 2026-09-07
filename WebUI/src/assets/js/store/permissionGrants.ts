import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'

/**
 * The reviewable grant list behind the Permissions layer (§4.7 of
 * docs/architecture-target.md). Every grant is one remembered or pre-granted
 * consent decision, keyed by the action vocabulary (`vram-warning:<preset>`,
 * `download:remote-turns`). There is no silent auto-allow: an entry here exists
 * only because the user ticked "do not show again" (origin `remember`) or
 * pre-filled it in Settings → Permissions (origin `pre-grant`), and every
 * entry is listed and revocable there.
 */

export type PermissionGrantOrigin = 'remember' | 'pre-grant'

export type PermissionGrant = {
  /** Action key, e.g. `vram-warning:LTX-Video` or `download:remote-turns`. */
  key: string
  origin: PermissionGrantOrigin
  createdAt: number
}

/** Remembered "don't warn again" for a gated high-memory / video-VRAM preset. */
export const VRAM_WARNING_GRANT_PREFIX = 'vram-warning:'
/** Pre-grant: skip the in-channel download confirmation on remote turns. */
export const REMOTE_DOWNLOAD_GRANT = 'download:remote-turns'

export function vramWarningGrantKey(presetName: string): string {
  return VRAM_WARNING_GRANT_PREFIX + presetName
}

/** One-time import: the presetSwitching memory-alert suppressions kept their
 *  "do not show again" flags in bare localStorage keys; they become grants. */
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
    // Remove even non-'1' leftovers so the migration runs once, not per boot.
    for (const key of stale) localStorage.removeItem(key)
  } catch {
    // localStorage unavailable (tests, hardened contexts): start empty.
  }
  return imported
}

export const usePermissionGrants = defineStore(
  'permissionGrants',
  () => {
    const grants = ref<Record<string, PermissionGrant>>(importLegacyMemoryAlerts())

    const list = computed<PermissionGrant[]>(() =>
      Object.values(grants.value).sort((a, b) => b.createdAt - a.createdAt),
    )

    function has(key: string): boolean {
      return Boolean(grants.value[key])
    }

    function grant(key: string, origin: PermissionGrantOrigin): void {
      grants.value[key] = { key, origin, createdAt: Date.now() }
    }

    function revoke(key: string): void {
      delete grants.value[key]
    }

    return { grants, list, has, grant, revoke }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: ['grants'],
    },
  },
)

// hot reloading
if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(usePermissionGrants, import.meta.hot))
}
