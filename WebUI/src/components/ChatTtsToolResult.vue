<template>
  <div v-if="output?.ok !== false && (playbackSrc || output?.savedFilePath)">
    <span class="text-muted-foreground block mb-2">{{ output?.message }}</span>
    <audio v-if="playbackSrc" controls class="w-full max-w-md" :src="playbackSrc" />
    <p v-else-if="loadError" class="text-xs text-destructive">{{ loadError }}</p>
    <p v-else class="text-xs text-muted-foreground">Loading audio…</p>
    <p v-if="output?.savedFilePath" class="text-xs text-muted-foreground mt-2 break-all">
      Saved: {{ output.savedFilePath }}
    </p>
  </div>
  <div v-else-if="output?.ok === false" class="text-xs text-destructive">
    {{ output.message }}
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'

type AudioLoadResult = { success: true; dataUri: string } | { success: false; error: string }

const props = defineProps<{
  output?: {
    ok?: boolean
    message?: string
    savedFilePath?: string
    /** Legacy persisted payloads only — stripped before the next save. */
    audioDataUri?: string
  }
  /** Workspace clips live outside the app audio folder, so Agent Mode supplies its own read. */
  loadAudio?: (filePath: string) => Promise<AudioLoadResult>
}>()

const playbackSrc = ref<string | null>(null)
const loadError = ref<string | null>(null)

onMounted(async () => {
  const out = props.output
  if (!out || out.ok === false) return

  if (out.audioDataUri) {
    playbackSrc.value = out.audioDataUri
    return
  }

  if (!out.savedFilePath) return

  try {
    const result = props.loadAudio
      ? await props.loadAudio(out.savedFilePath)
      : await window.electronAPI.readLocalAudioAsDataUri(out.savedFilePath)
    if (result.success) {
      playbackSrc.value = result.dataUri
    } else {
      loadError.value = result.error
    }
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  }
})
</script>
