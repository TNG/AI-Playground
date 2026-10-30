<template>
  <div v-if="output?.ok !== false && (playbackSrc || output?.savedFilePath)">
    <span class="text-muted-foreground block mb-2">{{ output?.message }}</span>
    <div v-if="playbackSrc" class="flex items-center gap-2">
      <audio
        controls
        :controlsList="download ? 'nodownload' : undefined"
        class="w-full max-w-md"
        :src="playbackSrc"
      />
      <IconButton
        v-if="download"
        icon="i-download"
        :tooltip="i18nState.COM_DOWNLOAD"
        @click="download()"
      />
      <IconButton
        v-if="reveal"
        icon="i-folder"
        :tooltip="i18nState.COM_OPEN_LOCATION"
        @click="reveal()"
      />
    </div>
    <p v-else-if="loadError" class="text-xs text-destructive">{{ loadError }}</p>
    <p v-else class="text-xs text-muted-foreground">Loading audio…</p>
    <p v-if="savedLine" class="text-xs text-muted-foreground mt-2 break-all">
      {{ savedLine }}
    </p>
  </div>
  <div v-else-if="output?.ok === false" class="text-xs text-destructive">
    {{ output.message }}
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import IconButton from '@/components/ui/IconButton.vue'

const props = defineProps<{
  output?: {
    ok?: boolean
    message?: string
    savedFilePath?: string
    /** Legacy persisted payloads only — stripped before the next save. */
    audioDataUri?: string
  }
  /** Shown instead of the saved file path. */
  caption?: string
  /** Replaces the player's own download. */
  download?: () => void
  /** Shows the file in the OS file manager. */
  reveal?: () => void
}>()

const i18nState = useI18N().state

const savedLine = computed(
  () =>
    props.caption ?? (props.output?.savedFilePath ? `Saved: ${props.output.savedFilePath}` : ''),
)

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
    const result = await window.electronAPI.readLocalAudioAsDataUri(out.savedFilePath)
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
