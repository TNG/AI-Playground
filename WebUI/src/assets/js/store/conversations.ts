import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref, watch, watchEffect } from 'vue'
import { demoAwareStorage } from '../demoAwareStorage'
import { AipgUiMessage } from './openAiCompatibleChat'
import { completeOrphanedToolParts, sanitizeBulkyToolOutputs } from './toolMessageSanitize'
import {
  backfillAudioThreadKind,
  findOrCreateEmptyThread,
  mintThreadKey,
  resolveThreadForKind,
  threadKindOf,
  type ConversationThreadMeta,
  type ThreadKind,
} from './conversationThreads'
import { currentPresetName } from '@/lib/presetRenames'

/**
 * Legacy fixed key for the original singleton Telegram thread. Kept only as a
 * migration token: at hydrate time we backfill `conversationThreadMeta` for it
 * so it shows up as a normal Home Agent thread alongside any newly created
 * remote conversations. Do NOT use this in new code — addressing happens via
 * `homeAgent.activeRemoteConversationKey` and `conversationThreadMeta`.
 */
export const HOME_AGENT_CONVERSATION_KEY = '__aipg_home_agent__'

export const HOME_AGENT_CONVERSATION_TITLE = 'Home Agent'

/**
 * Logical chat preset id for Home Agent inference. Lives in
 * `modes/base/presets/home-agent-chat.json`. Surfaces in the standard chat
 * preset picker: selecting it from `SettingsChat` jumps to the most recent
 * Home Agent conversation; selecting another preset off a Home Agent thread
 * spawns a fresh main conversation.
 */
export const HOME_AGENT_CHAT_PRESET_NAME = 'Home Agent'

export type { ConversationThreadMeta, ThreadKind } from './conversationThreads'

/** The two histories a mode switch moves between (Home Agent is a filter, not a mode). */
export type ModeThreadKind = 'main' | 'audio'

export type CreateConversationOptions = {
  kind?: ThreadKind
  presetName?: string
  variant?: string | null
}

export const useConversations = defineStore(
  'conversations',
  () => {
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

    /**
     * Most-recent main-kind thread the user was on. Mirrors
     * `homeAgent.activeRemoteConversationKey` for the Home Agent side so the
     * Local/Home Agent history switch can restore the user's "last active"
     * conversation per category instead of always snapping to the newest
     * thread by insertion order.
     */
    const lastMainKey = ref<string | null>(null)
    /** The same, for the Audio mode's own list (Text to Speech / Speech to Text). */
    const lastAudioKey = ref<string | null>(null)

    function updateConversation(messages: AipgUiMessage[], conversationKey: string) {
      // Never persist an orphaned tool call (interrupted/stopped turn): it would
      // brick the thread on the next generation. See toolMessageSanitize.ts.
      conversationList.value[conversationKey] = sanitizeBulkyToolOutputs(
        completeOrphanedToolParts(messages),
      )
    }

    function deleteConversation(conversationKey: string) {
      delete conversationList.value[conversationKey]
      delete conversationThreadMeta.value[conversationKey]
      delete conversationRagSelection.value[conversationKey]
    }

    function clearConversation(conversationKey: string) {
      conversationList.value[conversationKey] = []
    }

    function renameConversationTitle(conversationKey: string, newTitle: string) {
      const conversation = conversationList.value[conversationKey]
      if (!conversation || conversation.length === 0) return
      const firstMessage = conversation[0]
      firstMessage.metadata = {
        ...firstMessage.metadata,
        conversationTitle: newTitle,
      }
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

    function getThreadKind(conversationKey: string): ThreadKind {
      return threadKindOf(conversationThreadMeta.value, conversationKey)
    }

    /**
     * File a thread under a history without touching the preset it was stamped
     * with. Used when a list allocates its own draft, so an empty Audio thread is
     * in the Audio list before any turn has stamped a preset on it.
     */
    function setThreadKind(conversationKey: string, kind: ThreadKind) {
      const existing = conversationThreadMeta.value[conversationKey]
      conversationThreadMeta.value[conversationKey] = {
        ...existing,
        presetName: existing?.presetName ?? '',
        kind,
      }
    }

    function getThreadRagHashes(conversationKey: string): string[] {
      return conversationRagSelection.value[conversationKey] ?? []
    }

    function setThreadRagHashes(conversationKey: string, hashes: string[]) {
      conversationRagSelection.value[conversationKey] = [...new Set(hashes)]
    }

    // Keep the per-list "last active" keys synced with the most recently selected
    // thread of each kind, so switching back to a list (the Local/Home Agent
    // filter, or the Chat/Audio mode buttons) lands on what the user was working
    // in — not just the newest bucket by timestamp.
    watch(
      () => activeKey.value,
      (k) => {
        if (!k || !conversationList.value[k]) return
        const kind = getThreadKind(k)
        if (kind === 'main') lastMainKey.value = k
        else if (kind === 'audio') lastAudioKey.value = k
      },
      { immediate: true },
    )

    /**
     * Allocate a new conversation bucket and (optionally) seed thread metadata.
     * Returns the new conversation key. Used by both the main Chat "+" flow
     * and the Home Agent /new command.
     */
    function createConversation(options: CreateConversationOptions = {}): string {
      const newKey = mintThreadKey(conversationList.value)
      conversationList.value[newKey] = []
      if (options.presetName || options.kind) {
        conversationThreadMeta.value[newKey] = {
          presetName: options.presetName ?? '',
          variant: options.variant ?? null,
          kind: options.kind ?? 'main',
        }
      }
      return newKey
    }

    /**
     * Open a fresh (or the current empty) conversation in one of the lists. The
     * Audio list gets its kind stamped right away — an unstamped draft counts as
     * `main` and would show up under the Assistant.
     */
    function addNewConversation(kind: ThreadKind = 'main') {
      const newKey = findOrCreateEmptyThread(
        conversationList.value,
        conversationThreadMeta.value,
        kind,
      )
      if (kind !== 'main') setThreadKind(newKey, kind)
      activeKey.value = newKey
      return newKey
    }

    /**
     * Land on a list's own conversation, which is what makes Chat and Audio
     * separate histories: the mode owns the thread, so switching mode leaves the
     * other list's thread behind instead of appending to it.
     */
    function activateThreadForKind(kind: ModeThreadKind): string {
      const remembered = kind === 'audio' ? lastAudioKey.value : lastMainKey.value
      const resolved = resolveThreadForKind(
        conversationList.value,
        conversationThreadMeta.value,
        kind,
        remembered,
      )
      if (!resolved) return addNewConversation(kind)
      activeKey.value = resolved
      return resolved
    }

    const isNewConversation = (key: string) => conversationList.value[key].length === 0

    watchEffect(() => {
      if (Object.keys(conversationList.value).includes(activeKey.value)) return
      // Prefer the latest MAIN thread so app launch doesn't drop the user into a
      // Home Agent or Audio thread (which would also flip the desktop preset to
      // that thread's own preset via the activeKey watcher in textInference).
      // The app boots in Chat mode; `alignModeToActivePreset` moves it to Audio
      // afterwards when that is where the user left off, and takes the thread.
      const keys = Object.keys(conversationList.value)
      const meta = conversationThreadMeta.value
      let fallback: string | undefined
      for (let i = keys.length - 1; i >= 0; i--) {
        if (threadKindOf(meta, keys[i]) !== 'main') continue
        fallback = keys[i]
        break
      }
      if (!fallback) fallback = keys.at(-1)
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
      lastAudioKey,
      deleteConversation,
      clearConversation,
      isNewConversation,
      updateConversation,
      renameConversationTitle,
      ensureConversationBucket,
      setThreadMeta,
      getThreadMeta,
      getThreadKind,
      setThreadKind,
      getThreadRagHashes,
      setThreadRagHashes,
      createConversation,
      addNewConversation,
      activateThreadForKind,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [
        'conversationList',
        'conversationThreadMeta',
        'conversationRagSelection',
        'lastMainKey',
        'lastAudioKey',
      ],
      afterHydrate: (ctx) => {
        // Backfill legacy meta first so the helper below can correctly skip
        // Home Agent threads when looking for the "latest empty MAIN" tail.
        backfillLegacyHomeAgentThreadMeta(
          ctx.store.$state.conversationList,
          ctx.store.$state.conversationThreadMeta,
        )
        // A thread names the preset it was held with; a renamed preset no longer
        // answers to that name, which would leave the thread's preset unresolved.
        followRenamedPresets(ctx.store.$state.conversationThreadMeta)
        // Speech threads predate the Audio history and are stamped `main`, so
        // they have to be moved before anything reads a kind. Runs after the
        // rename pass, whose names this recognizes.
        backfillAudioThreadKind(ctx.store.$state.conversationThreadMeta)
        // Guarantee an empty Assistant draft: the app boots in Chat mode, and
        // its list must have somewhere to type. Audio allocates its own on
        // demand (`activateThreadForKind`).
        findOrCreateEmptyThread(
          ctx.store.$state.conversationList,
          ctx.store.$state.conversationThreadMeta,
          'main',
        )
      },
    },
  },
)

/**
 * Migrate the legacy singleton Home Agent thread to the new metadata model so
 * it shows up via `/history` and the desktop history list as a normal Home
 * Agent conversation.
 */
function backfillLegacyHomeAgentThreadMeta(
  list: Record<string, AipgUiMessage[]>,
  meta: Record<string, ConversationThreadMeta>,
) {
  if (!list[HOME_AGENT_CONVERSATION_KEY]) return
  if (meta[HOME_AGENT_CONVERSATION_KEY]?.kind === 'homeAgent') return
  meta[HOME_AGENT_CONVERSATION_KEY] = {
    ...meta[HOME_AGENT_CONVERSATION_KEY],
    presetName: HOME_AGENT_CHAT_PRESET_NAME,
    variant: null,
    kind: 'homeAgent',
  }
}

/**
 * Point threads stamped with a preset's former name at the name it ships with
 * now. Reopening such a thread applies its preset (see the `activeKey` watcher in
 * `textInference`), which does nothing when the stored name matches no preset.
 */
function followRenamedPresets(meta: Record<string, ConversationThreadMeta>) {
  for (const entry of Object.values(meta)) {
    if (entry.presetName) entry.presetName = currentPresetName(entry.presetName)
  }
}

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useConversations, import.meta.hot))
}
