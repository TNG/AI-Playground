<template>
  <div
    class="group/card relative flex aspect-square max-w-full items-center justify-center overflow-hidden rounded-lg bg-accent"
    :style="{ width: `min(100%, ${ARTIFACT_CARD_PX}px)` }"
  >
    <div
      v-if="artifact.state === 'deleted'"
      role="status"
      class="flex size-full min-h-24 items-center justify-center p-4 text-muted-foreground"
    >
      {{ languages.SESSION_FILE_DELETED }}
    </div>
    <div
      v-else-if="unfinished"
      role="status"
      class="flex size-full min-h-24 min-w-0 flex-col items-center justify-center gap-1 p-4 text-center text-sm"
    >
      <component
        :is="artifact.state === 'failed' ? ExclamationTriangleIcon : NoSymbolIcon"
        class="size-6"
        :class="artifact.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'"
        aria-hidden="true"
      />
      <p :class="artifact.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'">
        {{
          artifact.state === 'failed'
            ? languages.COM_GENERATE_FAILED
            : languages.SESSION_TURN_CANCELLED
        }}
      </p>
      <p v-if="artifact.reason" class="w-full truncate text-xs text-muted-foreground">
        {{ artifact.reason }}
      </p>
    </div>
    <div
      v-else-if="!hasDisplayableMedia(artifact.item)"
      class="size-full min-h-24 rounded-lg bg-gradient-to-br from-accent/30 to-muted/20"
    ></div>
    <img
      v-else-if="artifact.item.type === 'image'"
      alt="Generated result"
      class="block h-full w-full rounded-lg object-contain"
      :src="artifact.url"
      :draggable="artifact.state === 'done'"
      @dragstart="drag"
    />
    <video
      v-else-if="isVideo(artifact.item)"
      :src="artifact.url"
      aria-label="Generated result"
      class="block h-full w-full rounded-lg object-contain"
      controlsList="nodownload nofullscreen noremoteplayback"
      controls
      :draggable="artifact.state === 'done'"
      @dragstart="drag"
    />
    <!-- model-viewer sizes to 100% of its parent, so it needs an explicit box. -->
    <div
      v-else-if="is3D(artifact.item)"
      class="size-full"
      role="img"
      aria-label="Generated 3D model"
    >
      <Model3DViewer :src="artifact.url" />
    </div>

    <ArtifactProgress
      v-if="artifact.state === 'running'"
      :phase="artifact.phase"
      :progress="artifact.progress"
    />

    <ArtifactToolbar
      :actions="artifact.actions"
      class="absolute top-2 right-2 max-w-[calc(100%-1rem)] flex-wrap justify-end rounded-md bg-background/80 p-1 shadow-sm backdrop-blur-sm can-hover:opacity-0 transition-opacity group-hover/card:opacity-100 group-has-focus-visible/card:opacity-100"
      @action="(action) => emit('action', action)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ExclamationTriangleIcon, NoSymbolIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import ArtifactProgress from '@/components/ArtifactProgress.vue'
import ArtifactToolbar from '@/components/ArtifactToolbar.vue'
import Model3DViewer from '@/components/Model3DViewer.vue'
import { ARTIFACT_CARD_PX, type ArtifactAction, type TurnArtifact } from '@/lib/turnArtifacts'
import { hasDisplayableMedia, is3D, isVideo } from '@/types/mediaItem'

const props = defineProps<{ artifact: TurnArtifact }>()

const emit = defineEmits<{ action: [action: ArtifactAction] }>()

const languages = useI18N().state

const unfinished = computed(
  () => props.artifact.state === 'failed' || props.artifact.state === 'cancelled',
)

function drag(event: Event) {
  event.preventDefault()
  if (props.artifact.state === 'done') window.electronAPI.startDrag(props.artifact.url)
}
</script>
