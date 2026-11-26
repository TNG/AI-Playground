<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  ArrowTopRightOnSquareIcon,
  CubeIcon,
  MusicalNoteIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { useErrors } from '@/assets/js/store/errors'
import { useGallery } from '@/assets/js/store/gallery'
import { useI18N } from '@/assets/js/store/i18n'
import { relativeTime } from '@/assets/js/store/recordRows'
import { useSessionFiles } from '@/assets/js/store/sessionFiles'
import { useSessionLifecycle } from '@/assets/js/store/sessionLifecycle'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionTabs } from '@/assets/js/store/sessionTabs'
import DeleteArtifactDialog from '@/components/DeleteArtifactDialog.vue'
import FileArtifactCard from '@/components/FileArtifactCard.vue'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { artifactsInScope } from '@/lib/artifactsInScope'
import type { ArtifactsScope } from '@/lib/sessionTabs'
import type { SessionArtifact, SessionCreatedFile } from '@/types/sessionIpc'

const gallery = useGallery()
const sessionFiles = useSessionFiles()
const sessions = useSessions()
const sessionTabs = useSessionTabs()
const lifecycle = useSessionLifecycle()
const languages = useI18N().state
const errors = useErrors()

const deleting = ref<SessionArtifact | SessionCreatedFile | null>(null)

const SCOPES: { scope: ArtifactsScope; label: string }[] = [
  { scope: 'this-session', label: 'ARTIFACTS_THIS_SESSION' },
  { scope: 'all-sessions', label: 'ARTIFACTS_ALL_SESSIONS' },
]

const shown = computed(() =>
  artifactsInScope(gallery.artifacts, sessionTabs.artifactsScope, sessions.openSessionId),
)
const allSessions = computed(() => sessionTabs.artifactsScope === 'all-sessions')

/** One grid entry: a media artifact or a written file, ordered by timestamp. */
type GridEntry =
  | { kind: 'media'; artifact: SessionArtifact; at: number }
  | { kind: 'file'; file: SessionCreatedFile; at: number }

const entries = computed<GridEntry[]>(() => {
  const media: GridEntry[] = shown.value.map((artifact) => ({
    kind: 'media',
    artifact,
    at: artifact.timestamp,
  }))
  // Only files still on disk get a card; the missing ones stay in the store so
  // the transcript chips can strike them out.
  const scoped = (
    allSessions.value || !sessions.openSessionId
      ? sessionFiles.files
      : sessionFiles.files.filter((file) => file.sessionRef === sessions.openSessionId)
  ).filter((file) => file.exists)
  const files: GridEntry[] = scoped.map((file) => ({ kind: 'file', file, at: file.createdAt }))
  return [...media, ...files].sort((a, b) => b.at - a.at)
})

function keyOf(entry: GridEntry): string {
  return entry.kind === 'media'
    ? entry.artifact.url
    : `${entry.file.harnessSessionId}\u0000${entry.file.file}`
}

const loading = computed(() => gallery.loading || sessionFiles.loading)

onMounted(() => {
  void gallery.refresh()
  void sessionFiles.refresh()
})
watch(
  () => sessions.openTurn,
  (turn, previous) => {
    if (previous && !turn) {
      void gallery.refresh()
      void sessionFiles.refresh()
    }
  },
)
// A Channel turn can write files in a Session the app has open in the background.
watch(
  () => sessionTabs.artifactsScope,
  () => void sessionFiles.refresh(),
)

function sessionTitle(artifact: SessionArtifact): string {
  return artifact.sessionTitle || languages.SESSIONS_UNTITLED
}

async function openSession(artifact: SessionArtifact) {
  await lifecycle.openSession(artifact.sessionId, 'open-from-artifacts')
}

async function openWithSystem(artifact: SessionArtifact): Promise<void> {
  try {
    const result = await window.electronAPI.sessions.openArtifact(artifact.sessionId, artifact.url)
    if (!result.success)
      errors.report(new Error(result.error), {
        code: 'artifacts/open-failed',
        category: 'backend',
        surface: 'toast',
      })
  } catch (error) {
    errors.report(error, { code: 'artifacts/open-failed', category: 'backend', surface: 'toast' })
  }
}

function isMedia(entry: SessionArtifact | SessionCreatedFile): entry is SessionArtifact {
  return 'url' in entry
}

async function confirmDelete() {
  const target = deleting.value
  deleting.value = null
  if (!target) return
  if (isMedia(target)) {
    await gallery.remove(target)
    return
  }
  try {
    const result = await window.electronAPI.agentMode.sessionFileAction(
      target.harnessSessionId,
      target.file,
      'delete',
    )
    if (!result.success) {
      errors.report(new Error(result.error), {
        code: 'artifacts/file-delete-failed',
        category: 'backend',
        surface: 'toast',
      })
      return
    }
  } catch (error) {
    errors.report(error, {
      code: 'artifacts/file-delete-failed',
      category: 'backend',
      surface: 'toast',
    })
    return
  }
  await sessionFiles.refresh()
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col text-foreground">
    <header class="flex items-center gap-3 px-4 py-3">
      <div
        role="radiogroup"
        :aria-label="languages.ARTIFACTS_SCOPE"
        class="flex rounded-md border border-border p-0.5"
      >
        <button
          v-for="option in SCOPES"
          :key="option.scope"
          type="button"
          role="radio"
          :aria-checked="sessionTabs.artifactsScope === option.scope"
          class="rounded px-3 py-1 text-sm transition-colors"
          :class="
            sessionTabs.artifactsScope === option.scope
              ? 'bg-muted text-foreground'
              : 'text-muted-foreground hover:text-foreground'
          "
          @click="sessionTabs.artifactsScope = option.scope"
        >
          {{ languages[option.label] }}
        </button>
      </div>
      <Spinner v-if="loading" class="size-4" />
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <p
        v-if="!loading && entries.length === 0"
        class="flex h-full items-center justify-center text-center text-muted-foreground"
      >
        {{ allSessions ? languages.ARTIFACTS_EMPTY_ALL : languages.ARTIFACTS_EMPTY_SESSION }}
      </p>
      <TooltipProvider v-else :delay-duration="200">
        <ul class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
          <template v-for="entry in entries" :key="keyOf(entry)">
            <li v-if="entry.kind === 'file'" class="min-w-0">
              <FileArtifactCard
                :file="entry.file.file"
                :harness-session-id="entry.file.harnessSessionId"
                :created-at="entry.file.createdAt"
                :session-title="entry.file.sessionTitle"
                :session-ref="entry.file.sessionRef"
                @delete="deleting = entry.file"
              />
            </li>
            <li
              v-else
              role="group"
              :aria-label="entry.artifact.prompt || sessionTitle(entry.artifact)"
              class="flex flex-col overflow-hidden rounded-lg border border-border bg-muted"
            >
              <div
                class="flex aspect-square min-h-0 items-center justify-center overflow-hidden bg-accent"
              >
                <img
                  v-if="entry.artifact.mediaType === 'image'"
                  :src="entry.artifact.url"
                  :alt="entry.artifact.prompt"
                  class="h-full w-full object-contain"
                />
                <video
                  v-else-if="entry.artifact.mediaType === 'video'"
                  :src="entry.artifact.url"
                  controls
                  preload="metadata"
                  class="h-full w-full object-contain"
                />
                <CubeIcon
                  v-else-if="entry.artifact.mediaType === 'model3d'"
                  class="size-12 text-muted-foreground"
                />
                <div v-else class="flex w-full flex-col items-center gap-3 px-3">
                  <MusicalNoteIcon class="size-12 text-muted-foreground" />
                  <audio
                    :src="entry.artifact.url"
                    controls
                    preload="metadata"
                    class="w-full"
                  ></audio>
                </div>
              </div>
              <div class="flex flex-1 flex-col gap-1 px-3 py-2">
                <p class="truncate text-sm">
                  {{ entry.artifact.prompt || entry.artifact.preset }}
                </p>
                <p class="truncate text-xs text-muted-foreground">
                  <template v-if="allSessions">{{ sessionTitle(entry.artifact) }} · </template>
                  {{ relativeTime(entry.artifact.timestamp) }}
                </p>
                <div class="mt-1 flex items-center justify-between gap-2">
                  <Button
                    v-if="entry.artifact.sessionId !== sessions.openSessionId"
                    variant="ghost"
                    size="sm"
                    class="px-2"
                    @click="openSession(entry.artifact)"
                  >
                    {{ languages.GALLERY_OPEN_SESSION }}
                  </Button>
                  <span v-else></span>
                  <div class="flex items-center">
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <Button
                          variant="ghost"
                          size="icon"
                          class="h-8 w-8"
                          :aria-label="languages.ANSWER_FILE_OPEN_TOOLTIP"
                          @click="openWithSystem(entry.artifact)"
                        >
                          <ArrowTopRightOnSquareIcon class="size-4" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{{ languages.ANSWER_FILE_OPEN_TOOLTIP }}</TooltipContent>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <Button
                          variant="ghost"
                          size="icon"
                          class="h-8 w-8"
                          :aria-label="languages.ARTIFACT_DELETE"
                          @click="deleting = entry.artifact"
                        >
                          <TrashIcon class="size-4" aria-hidden="true" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>{{ languages.ARTIFACT_DELETE }}</TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </li>
          </template>
        </ul>
      </TooltipProvider>
    </div>

    <DeleteArtifactDialog
      :open="deleting !== null"
      @update:open="(open) => !open && (deleting = null)"
      @confirm="confirmDelete"
    />
  </div>
</template>
