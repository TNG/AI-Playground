import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { useErrors } from '@/assets/js/store/errors'
import type { SessionCreatedFile } from '@/types/sessionIpc'

/** The files the Sessions' agent turns wrote, as the Artifacts tab lists them. */
export const useSessionFiles = defineStore('sessionFiles', () => {
  const errors = useErrors()

  const files = ref<SessionCreatedFile[]>([])
  const loading = ref(false)

  function report(error: unknown, code: string): void {
    errors.report(error, { code, category: 'backend', surface: 'toast' })
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const result = await window.electronAPI.sessions.listCreatedFiles()
      if (result.success) files.value = result.files
      else report(new Error(result.error), 'session-files/list-failed')
    } catch (error) {
      report(error, 'session-files/list-failed')
    } finally {
      loading.value = false
    }
  }

  return { files, loading, refresh }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useSessionFiles, import.meta.hot))
}
