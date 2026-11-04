<template>
  <div class="relative flex min-h-14 w-full max-w-md items-center gap-2 rounded-lg bg-accent p-2">
    <template v-if="artifact.state === 'running'">
      <div class="h-10 flex-1"></div>
      <ArtifactProgress :phase="artifact.phase" />
    </template>
    <p
      v-else-if="artifact.state === 'deleted'"
      role="status"
      class="flex-1 px-2 text-sm text-muted-foreground"
    >
      {{ languages.SESSION_FILE_DELETED }}
    </p>
    <p
      v-else-if="artifact.state === 'failed'"
      class="line-clamp-2 flex-1 px-2 text-sm text-red-500 wrap-break-word"
    >
      {{ failureText }}
    </p>
    <p v-else-if="artifact.state === 'cancelled'" class="flex-1 px-2 text-sm text-muted-foreground">
      {{ languages.SESSION_AUDIO_CANCELLED }}
    </p>
    <template v-else>
      <audio
        v-if="playbackSrc"
        controls
        controlsList="nodownload"
        class="min-w-0 flex-1"
        :src="playbackSrc"
        aria-label="Generated speech"
      />
      <p v-else-if="loadError" class="flex-1 px-2 text-xs text-destructive">{{ loadError }}</p>
      <div v-else class="h-10 flex-1 animate-pulse rounded-md bg-muted"></div>
      <TooltipProvider :delay-duration="200">
        <div
          v-if="artifact.actions.length > 0"
          role="toolbar"
          :aria-label="languages.ARTIFACT_ACTIONS"
          class="flex shrink-0 gap-1"
        >
          <Tooltip v-for="action in toolbarActions" :key="action.id">
            <TooltipTrigger as-child>
              <button
                type="button"
                class="flex size-7 items-center justify-center rounded-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
                :aria-label="action.label"
                @click="runAction(action.id)"
              >
                <component :is="action.icon" class="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{{ action.label }}</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </template>
    <DeleteArtifactDialog
      :open="confirmingDelete"
      @update:open="(open) => (confirmingDelete = open)"
      @confirm="confirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import { ArrowDownTrayIcon, FolderOpenIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useErrors } from '@/assets/js/store/errors'
import { useGallery } from '@/assets/js/store/gallery'
import { useI18N } from '@/assets/js/store/i18n'
import ArtifactProgress from '@/components/ArtifactProgress.vue'
import DeleteArtifactDialog from '@/components/DeleteArtifactDialog.vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { AudioArtifact } from '@/lib/audioArtifacts'
import type { ArtifactAction } from '@/lib/turnArtifacts'

/** The one audio card: every speech clip a Turn shows, whoever made it. */
const props = defineProps<{ artifact: AudioArtifact }>()

const languages = useI18N().state
const errors = useErrors()
const gallery = useGallery()
const agentMode = useAgentMode()
const confirmingDelete = ref(false)

const failureText = computed(() =>
  props.artifact.reason
    ? `${languages.SESSION_AUDIO_TTS_FAILED}: ${props.artifact.reason}`
    : languages.SESSION_AUDIO_TTS_FAILED,
)

const playbackSrc = ref<string | null>(null)
const loadError = ref<string | null>(null)

// A clip outside the Session Folder sits in the audio folder, which the page cannot load directly.
watch(
  () => [props.artifact.state, props.artifact.url, props.artifact.filePath] as const,
  async ([state, url, filePath]) => {
    loadError.value = null
    playbackSrc.value = url ?? null
    if (state !== 'done' || url || !filePath) return
    try {
      const result = await window.electronAPI.readLocalAudioAsDataUri(filePath)
      if (result.success) playbackSrc.value = result.dataUri
      else loadError.value = result.error
    } catch (error) {
      loadError.value = error instanceof Error ? error.message : String(error)
    }
  },
  { immediate: true },
)

const ACTIONS: Partial<Record<ArtifactAction, { icon: Component; label: () => string }>> = {
  download: { icon: ArrowDownTrayIcon, label: () => languages.COM_DOWNLOAD },
  openFolder: { icon: FolderOpenIcon, label: () => languages.COM_OPEN_LOCATION },
  delete: { icon: TrashIcon, label: () => languages.ARTIFACT_DELETE },
}

const toolbarActions = computed(() =>
  props.artifact.actions.flatMap((id) => {
    const action = ACTIONS[id]
    return action ? [{ id, icon: action.icon, label: action.label() }] : []
  }),
)

async function fileOutsideSession(action: 'saveAs' | 'reveal', filePath: string) {
  const { workspacePath } = props.artifact
  const result = await window.electronAPI.agentMode.mediaFileAction(
    {
      sessionId: agentMode.openSessionId,
      appCopy: filePath,
      ...(workspacePath ? { workspacePath } : {}),
    },
    action,
  )
  if (!result.success) throw new Error(result.error)
}

async function runAction(action: ArtifactAction) {
  const { url, filePath } = props.artifact
  try {
    if (action === 'delete') {
      confirmingDelete.value = true
      return
    }
    if (!url) {
      if (filePath) await fileOutsideSession(action === 'download' ? 'saveAs' : 'reveal', filePath)
      return
    }
    if (action === 'openFolder') return window.electronAPI.openImageInFolder(url)
    const result = await window.electronAPI.saveMediaCopy(url)
    if (!result.success) throw new Error(result.error)
  } catch (error) {
    errors.report(error, { code: `artifact/${action}-failed`, surface: 'toast' })
  }
}

async function confirmDelete() {
  confirmingDelete.value = false
  if (props.artifact.url) await gallery.removeByUrl(props.artifact.url)
}
</script>
