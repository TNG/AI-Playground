import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref } from 'vue'
import { useErrors } from '@/assets/js/store/errors'
import { useSessions } from '@/assets/js/store/sessions'
import { sessionMediaPathOf } from '@/lib/comfyWorkflow'
import type { TurnRemoval } from '@/lib/turnTypes'
import type { SessionArtifact } from '@/types/sessionIpc'

/** Everything the user made, read from the History Entries of every Session. */
export const useGallery = defineStore('gallery', () => {
  const errors = useErrors()
  const sessions = useSessions()

  const artifacts = ref<SessionArtifact[]>([])
  const loading = ref(false)

  function report(error: unknown, code: string): void {
    errors.report(error, { code, category: 'backend', surface: 'toast' })
  }

  async function refresh(): Promise<void> {
    loading.value = true
    try {
      const result = await window.electronAPI.sessions.listArtifacts()
      if (result.success) artifacts.value = result.artifacts
      else report(new Error(result.error), 'gallery/list-failed')
    } catch (error) {
      report(error, 'gallery/list-failed')
    } finally {
      loading.value = false
    }
  }

  async function deleteFile(sessionId: string, url: string): Promise<boolean> {
    try {
      const result = await window.electronAPI.sessions.deleteArtifact(sessionId, url)
      if (!result.success) {
        report(new Error(result.error), 'gallery/delete-failed')
        return false
      }
    } catch (error) {
      report(error, 'gallery/delete-failed')
      return false
    }
    artifacts.value = artifacts.value.filter((artifact) => artifact.url !== url)
    sessions.markFileDeleted(sessionId, url)
    return true
  }

  async function remove(artifact: SessionArtifact): Promise<boolean> {
    return deleteFile(artifact.sessionId, artifact.url)
  }

  /** Deletes the file behind a timeline card; a URL outside every Session names no artifact. */
  async function removeByUrl(url: string): Promise<boolean> {
    const target = sessionMediaPathOf(url)
    if (!target) return false
    return deleteFile(target.sessionId, url)
  }

  /** Takes a settled media or speech turn out of the Session: its messages, then its files. */
  async function removeTurn(sessionId: string, removal: TurnRemoval): Promise<void> {
    await sessions.removeTimelineMessages(sessionId, removal.messageIds)
    for (const url of removal.fileUrls) await removeByUrl(url)
  }

  return { artifacts, loading, refresh, remove, removeByUrl, removeTurn }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useGallery, import.meta.hot))
}
