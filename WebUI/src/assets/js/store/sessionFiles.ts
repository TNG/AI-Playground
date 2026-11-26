import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { useErrors } from '@/assets/js/store/errors'
import type { SessionCreatedFile } from '@/types/sessionIpc'

/** How a file is keyed against the Harness Session whose workspace holds it. */
export function missingFileKey(harnessSessionId: string, file: string): string {
  return `${harnessSessionId}\u0000${file}`
}

/** The files the Sessions' agent turns wrote, as the Artifacts tab lists them. */
export const useSessionFiles = defineStore('sessionFiles', () => {
  const errors = useErrors()

  const files = ref<SessionCreatedFile[]>([])
  const loading = ref(false)
  // Click- and rewrite-discovered truth on top of the listing: a preview read
  // that says a file is gone (or succeeds again), or a streaming turn's fresh
  // write of a same-named deleted file, recorded until a refresh re-scans disk.
  const presence = ref<Map<string, boolean>>(new Map())

  const missingFileKeys = computed<Set<string>>(() => {
    const keys = new Set<string>()
    for (const file of files.value) {
      if (!file.exists) keys.add(missingFileKey(file.harnessSessionId, file.file))
    }
    for (const [key, missing] of presence.value) {
      if (missing) keys.add(key)
      else keys.delete(key)
    }
    return keys
  })

  function markMissing(harnessSessionId: string, file: string): void {
    if (!harnessSessionId) return
    presence.value = new Map(presence.value).set(missingFileKey(harnessSessionId, file), true)
  }

  function markPresent(harnessSessionId: string, file: string): void {
    presence.value = new Map(presence.value).set(missingFileKey(harnessSessionId, file), false)
  }

  function report(error: unknown, code: string): void {
    errors.report(error, { code, category: 'backend', surface: 'toast' })
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const result = await window.electronAPI.sessions.listCreatedFiles()
      if (result.success) {
        files.value = result.files
        // The fresh scan is the disk-accurate word for every key it resolved,
        // so its truth replaces any recorded presence; keys it could not
        // resolve keep their recorded truth, a click's included.
        const resolved = new Set(
          result.files.map((file) => missingFileKey(file.harnessSessionId, file.file)),
        )
        if (resolved.size > 0)
          presence.value = new Map([...presence.value].filter(([key]) => !resolved.has(key)))
      } else report(new Error(result.error), 'session-files/list-failed')
    } catch (error) {
      report(error, 'session-files/list-failed')
    } finally {
      loading.value = false
    }
  }

  return { files, loading, missingFileKeys, markMissing, markPresent, refresh }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionFiles, import.meta.hot))
}
