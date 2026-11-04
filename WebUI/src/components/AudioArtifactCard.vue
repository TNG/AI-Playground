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
      v-else-if="artifact.state === 'failed' || loadFailed"
      role="status"
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
      <div v-else class="h-10 flex-1 animate-pulse rounded-md bg-muted"></div>
      <ArtifactToolbar :actions="artifact.actions" class="shrink-0" @action="runAction" />
    </template>
    <DeleteArtifactDialog
      :open="confirmingDelete"
      @update:open="(open) => (confirmingDelete = open)"
      @confirm="confirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { createAppError } from '@/assets/js/errors/appError'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useErrors } from '@/assets/js/store/errors'
import { useGallery } from '@/assets/js/store/gallery'
import { useI18N } from '@/assets/js/store/i18n'
import ArtifactProgress from '@/components/ArtifactProgress.vue'
import ArtifactToolbar from '@/components/ArtifactToolbar.vue'
import DeleteArtifactDialog from '@/components/DeleteArtifactDialog.vue'
import type { AudioArtifact } from '@/lib/audioArtifacts'
import type { ArtifactAction } from '@/lib/turnArtifacts'
import { useArtifactActions } from '@/lib/useArtifactActions'

const props = defineProps<{ artifact: AudioArtifact }>()

const languages = useI18N().state
const errors = useErrors()
const gallery = useGallery()
const agentMode = useAgentMode()
const { reportFailure } = useArtifactActions()
const confirmingDelete = ref(false)

const playbackSrc = ref<string | null>(null)
const loadFailed = ref(false)

const failureText = computed(() => {
  if (loadFailed.value) return languages.SESSION_AUDIO_LOAD_FAILED
  return props.artifact.reason
    ? `${languages.SESSION_AUDIO_TTS_FAILED}: ${props.artifact.reason}`
    : languages.SESSION_AUDIO_TTS_FAILED
})

// A clip outside the Session Folder sits in the audio folder, which the page cannot load directly.
watch(
  () => [props.artifact.state, props.artifact.url, props.artifact.filePath] as const,
  async ([state, url, filePath]) => {
    loadFailed.value = false
    playbackSrc.value = url ?? null
    if (state !== 'done' || url || !filePath) return
    try {
      const result = await window.electronAPI.readLocalAudioAsDataUri(filePath)
      if (!result.success) throw new Error(result.error)
      playbackSrc.value = result.dataUri
    } catch (error) {
      loadFailed.value = true
      errors.report(
        createAppError({
          category: 'generation',
          code: 'artifact/audio-load-failed',
          userMessage: languages.SESSION_AUDIO_LOAD_FAILED,
          technicalMessage: error instanceof Error ? error.message : String(error),
          surface: 'silent',
          context: { filePath },
          cause: error,
        }),
      )
    }
  },
  { immediate: true },
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
    reportFailure(action, error)
  }
}

async function confirmDelete() {
  confirmingDelete.value = false
  if (props.artifact.url) await gallery.removeByUrl(props.artifact.url)
}
</script>
