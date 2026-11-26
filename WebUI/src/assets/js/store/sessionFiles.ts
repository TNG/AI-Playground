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
  // Click-discovered deletions: a chip whose preview read says the file is gone
  // stays struck until a refresh proves it exists again.
  const markedMissing = ref<Set<string>>(new Set())

  const missingFileKeys = computed<Set<string>>(() => {
    const keys = new Set(markedMissing.value)
    for (const file of files.value) {
      if (!file.exists) keys.add(missingFileKey(file.harnessSessionId, file.file))
    }
    return keys
  })

  function markMissing(harnessSessionId: string, file: string): void {
    if (!harnessSessionId) return
    const next = new Set(markedMissing.value)
    next.add(missingFileKey(harnessSessionId, file))
    markedMissing.value = next
  }

  function markPresent(harnessSessionId: string, file: string): void {
    const key = missingFileKey(harnessSessionId, file)
    if (!markedMissing.value.has(key)) return
    const next = new Set(markedMissing.value)
    next.delete(key)
    markedMissing.value = next
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
        // A refresh is the disk-accurate word: only a file it reports existing
        // gets its click-discovered mark cleared; unresolved pairs keep theirs.
        const present = new Set(
          result.files
            .filter((file) => file.exists)
            .map((file) => missingFileKey(file.harnessSessionId, file.file)),
        )
        if (present.size > 0)
          markedMissing.value = new Set([...markedMissing.value].filter((key) => !present.has(key)))
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
