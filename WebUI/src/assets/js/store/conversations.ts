import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch, watchEffect } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { AipgUiMessage } from './openAiCompatibleChat'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from '@/lib/toolMessageSanitize'
import { currentPresetName } from '@/lib/presetRenames'
import { makeForwardPersist } from '@/lib/ipcPersist'
import { cloneForIpc } from '@/lib/cloneForIpc'
import { sessionIdOfChatKey } from '@/lib/sessionChat'
import { useErrors } from './errors'
import { modelDownloads } from '../models/modelDownloadQueue'
import type { ConversationBootstrap, ConversationLegacyState } from '@/types/conversationIpc'

/**
 * Per-conversation inference profile snapshot. Stamped on every outbound
 * generate/regenerate so the thread is reproducible and "revisit = reactivate"
 * works in the Chat UI.
 */
export type ConversationThreadMeta = {
  presetName: string
  variant?: string | null
}

// The old Pinia-persist key (store id). Read exactly once — the one-shot
// localStorage migration (architecture-target §6.1, step 8) — and removed
// after the kernel has written the files.
const LEGACY_STORAGE_KEY = 'conversations'

export const useConversations = defineStore('conversations', () => {
  const conversationList = ref<Record<string, AipgUiMessage[]>>({})
  const conversationThreadMeta = ref<Record<string, ConversationThreadMeta>>({})
  /**
   * Per-conversation RAG document selection: conversationKey -> enabled doc
   * hashes. The indexed-document library itself stays shared/global (in
   * `textInference.ragList`); only which documents are *enabled* is scoped to
   * the conversation. A conversation with no entry has nothing enabled, so a
   * brand-new conversation starts without active RAG documents.
   */
  const conversationRagSelection = ref<Record<string, string[]>>({})
  const activeKey = ref('')
  const activeConversation = computed(() => conversationList.value[activeKey.value])

  /** Most-recent thread the user was on that is no Session's chat. */
  const lastMainKey = ref<string | null>(null)

  /** Set once `init()` has hydrated (or migrated) — gates every write-through. */
  const hydrated = ref(false)
  let initPromise: Promise<void> | null = null

  // The kernel owns the files; failures surface through the error sink but
  // never break the live copy — a failed write must not take the thread down.
  const persistMutation = makeForwardPersist({
    code: 'conversations/persist-failed',
    technicalMessage: 'saving a conversation file failed',
  })

  function forwardPersist(call: () => Promise<unknown>): void {
    if (!hydrated.value) return
    persistMutation(call)
  }

  function saveThread(conversationKey: string): void {
    const sessionId = sessionIdOfChatKey(conversationKey)
    if (sessionId) {
      forwardPersist(() =>
        window.electronAPI.sessions.saveChatTranscript(
          sessionId,
          cloneForIpc(conversationList.value[conversationKey] ?? []),
        ),
      )
      return
    }
    forwardPersist(() =>
      window.electronAPI.conversations.save(
        cloneForIpc({
          id: conversationKey,
          meta: conversationThreadMeta.value[conversationKey] ?? null,
          ragHashes: conversationRagSelection.value[conversationKey] ?? [],
          messages: conversationList.value[conversationKey] ?? [],
          lastMainKey: lastMainKey.value,
        }),
      ),
    )
  }

  function applyConversationMessages(messages: AipgUiMessage[], conversationKey: string) {
    // Never persist an orphaned tool call (interrupted/stopped turn): it would
    // brick the thread on the next generation. See src/lib/toolMessageSanitize.ts.
    conversationList.value[conversationKey] = sanitizeBulkyToolOutputs(
      completeOrphanedToolParts(messages),
    )
  }

  function updateConversation(messages: AipgUiMessage[], conversationKey: string) {
    applyConversationMessages(messages, conversationKey)
    saveThread(conversationKey)
  }

  function deleteConversation(conversationKey: string) {
    modelDownloads().detachGroup(conversationKey)
    delete conversationList.value[conversationKey]
    delete conversationThreadMeta.value[conversationKey]
    delete conversationRagSelection.value[conversationKey]
    if (sessionIdOfChatKey(conversationKey)) return
    forwardPersist(() => window.electronAPI.conversations.delete(conversationKey))
  }

  function clearConversation(conversationKey: string) {
    conversationList.value[conversationKey] = []
    saveThread(conversationKey)
  }

  function renameConversationTitle(conversationKey: string, newTitle: string) {
    const conversation = conversationList.value[conversationKey]
    if (!conversation || conversation.length === 0) return
    const firstMessage = conversation[0]
    firstMessage.metadata = {
      ...firstMessage.metadata,
      conversationTitle: newTitle,
    }
    // The index entry carries the title, so a rename must reach the writer.
    saveThread(conversationKey)
  }

  function ensureConversationBucket(conversationKey: string) {
    if (!(conversationKey in conversationList.value)) {
      conversationList.value[conversationKey] = []
    }
  }

  function setThreadMeta(conversationKey: string, meta: ConversationThreadMeta) {
    conversationThreadMeta.value[conversationKey] = {
      ...conversationThreadMeta.value[conversationKey],
      ...meta,
    }
  }

  function getThreadMeta(conversationKey: string): ConversationThreadMeta | undefined {
    return conversationThreadMeta.value[conversationKey]
  }

  function getThreadRagHashes(conversationKey: string): string[] {
    return conversationRagSelection.value[conversationKey] ?? []
  }

  function setThreadRagHashes(conversationKey: string, hashes: string[]) {
    conversationRagSelection.value[conversationKey] = [...new Set(hashes)]
    saveThread(conversationKey)
  }

  // Keep `lastMainKey` synced with the most recently selected main thread so
  // toggling the history filter back to Local lands on what the user was
  // working in (not just the newest bucket by timestamp).
  watch(
    () => activeKey.value,
    (k) => {
      if (k && conversationList.value[k] && !sessionIdOfChatKey(k)) {
        lastMainKey.value = k
        forwardPersist(() => window.electronAPI.conversations.saveLastMainKey(k))
      }
    },
    { immediate: true },
  )

  function addNewConversation() {
    const list = conversationList.value
    const newKey = addNewConversationIfLatestIsNotEmpty(list)
    activeKey.value = newKey
    return newKey
  }

  const isNewConversation = (key: string) => conversationList.value[key].length === 0

  // ── Hydration (step 8, architecture-target §6.1) ──────────────────────────────
  //
  // The kernel owns the durable copy (`AI-Playground/conversations/`); this
  // store is the live projection. `init()` runs once before the app mounts,
  // so a resumed stream or the history panel never sees a half-hydrated map.

  function hydrateFrom(bootstrap: ConversationBootstrap): void {
    if (bootstrap.status !== 'ok') return
    const list: Record<string, AipgUiMessage[]> = {}
    const meta: Record<string, ConversationThreadMeta> = {}
    const rag: Record<string, string[]> = {}
    for (const thread of bootstrap.threads) {
      list[thread.id] = thread.messages as AipgUiMessage[]
      if (thread.meta) meta[thread.id] = thread.meta
      if (thread.ragHashes.length > 0) rag[thread.id] = thread.ragHashes
    }
    conversationList.value = list
    conversationThreadMeta.value = meta
    conversationRagSelection.value = rag
    if (bootstrap.lastMainKey) lastMainKey.value = bootstrap.lastMainKey
  }

  /** Read the legacy Pinia-persisted state, if any, for the one-shot upload. */
  function readLegacyState(): ConversationLegacyState | null {
    const raw = demoAwareStorage.getItem(LEGACY_STORAGE_KEY)
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<ConversationLegacyState>
      if (!parsed || typeof parsed !== 'object' || !parsed.conversationList) return null
      return {
        conversationList: parsed.conversationList,
        conversationThreadMeta: parsed.conversationThreadMeta ?? {},
        conversationRagSelection: parsed.conversationRagSelection ?? {},
        lastMainKey: parsed.lastMainKey ?? null,
      }
    } catch {
      return null
    }
  }

  async function init(): Promise<void> {
    if (initPromise) return initPromise
    initPromise = (async () => {
      const errors = useErrors()
      let bootstrap: ConversationBootstrap | { status: 'error'; error: string } | null = null
      let bootstrapError: unknown = null
      try {
        bootstrap = await window.electronAPI.conversations.bootstrap()
        // One-shot legacy migration (§6.1: "localStorage migrates once"): a
        // first boot with no index uploads whatever the old persisted state
        // held, then drops the key so it never runs or dual-writes again.
        if (
          bootstrap.status === 'empty' ||
          (bootstrap.status === 'ok' && bootstrap.threads.length === 0)
        ) {
          const legacy = readLegacyState()
          if (legacy && Object.keys(legacy.conversationList).length > 0) {
            bootstrap = await window.electronAPI.conversations.migrate(legacy)
          }
        }
        // Files own the threads: drop the Pinia key. Keep it when migrate
        // failed so the next boot can retry.
        if (
          bootstrap.status === 'ok' ||
          (bootstrap.status === 'empty' && demoAwareStorage.getItem(LEGACY_STORAGE_KEY))
        ) {
          demoAwareStorage.removeItem(LEGACY_STORAGE_KEY)
        }
      } catch (error) {
        bootstrap = null
        bootstrapError = error
      }
      if (!bootstrap) {
        errors.report(bootstrapError ?? new Error('conversation bootstrap IPC failed'), {
          code: 'conversations/bootstrap-failed',
          category: 'backend',
          severity: 'warning',
          surface: 'silent',
          technicalMessage: 'the file store did not answer; history may be empty this session',
        })
      } else if (bootstrap.status === 'error') {
        errors.report(new Error(bootstrap.error), {
          code: 'conversations/bootstrap-failed',
          category: 'backend',
          severity: 'warning',
          surface: 'silent',
          technicalMessage: 'the file store rejected the boot hydration',
        })
        bootstrap = null
      }
      if (bootstrap) hydrateFrom(bootstrap)
      // A thread names the preset it was held with; a renamed preset no longer
      // answers to that name, which would leave the thread's preset unresolved.
      followRenamedPresets(conversationThreadMeta.value)
      // A session always opens on an empty main draft; it materializes on
      // disk with its first content.
      addNewConversationIfLatestIsNotEmpty(conversationList.value)
      hydrated.value = true
    })()
    return initPromise
  }

  watchEffect(() => {
    if (Object.keys(conversationList.value).includes(activeKey.value)) return
    const fallback = Object.keys(conversationList.value).at(-1)
    if (!fallback) return
    activeKey.value = fallback
  })

  return {
    conversationList,
    conversationThreadMeta,
    conversationRagSelection,
    activeKey,
    activeConversation,
    lastMainKey,
    hydrated,
    init,
    deleteConversation,
    clearConversation,
    isNewConversation,
    updateConversation,
    applyConversationMessages,
    renameConversationTitle,
    ensureConversationBucket,
    setThreadMeta,
    getThreadMeta,
    getThreadRagHashes,
    setThreadRagHashes,
    addNewConversation,
  }
})

/**
 * Find or allocate the "current empty bucket" — the most recently inserted
 * conversation, reused when empty so we don't accumulate a long tail of empty drafts.
 */
function addNewConversationIfLatestIsNotEmpty(list: Record<string, AipgUiMessage[]>): string {
  const latestKey = Object.keys(list).at(-1)
  if (latestKey && list[latestKey].length === 0) return latestKey
  const newKey = new Date().getTime().toString()
  list[newKey] = []
  return newKey
}

/**
 * Point threads stamped with a preset's former name at the name it ships with
 * now. Reopening such a thread applies its preset (see the `activeKey` watcher
 * in `textInference`), which does nothing when the stored name matches no preset.
 */
function followRenamedPresets(meta: Record<string, ConversationThreadMeta>) {
  for (const entry of Object.values(meta)) {
    if (entry.presetName) entry.presetName = currentPresetName(entry.presetName)
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConversations, import.meta.hot))
}
