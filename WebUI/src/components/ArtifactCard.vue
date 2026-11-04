<template>
  <div
    class="group relative flex max-w-full items-center justify-center rounded-lg bg-accent"
    :style="frameStyle"
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
      class="block max-w-full object-contain rounded-lg"
      :class="artifact.size ? 'max-h-full' : 'max-h-[70vh]'"
      :src="artifact.url"
      :draggable="artifact.state === 'done'"
      @dragstart="drag"
    />
    <video
      v-else-if="isVideo(artifact.item)"
      :src="artifact.url"
      aria-label="Generated result"
      class="block max-w-full object-contain rounded-lg"
      :class="artifact.size ? 'max-h-full' : 'max-h-[70vh]'"
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

    <TooltipProvider :delay-duration="200">
      <div
        v-if="toolbarActions.length > 0"
        role="toolbar"
        :aria-label="languages.ARTIFACT_ACTIONS"
        class="absolute top-2 right-2 flex max-w-[calc(100%-1rem)] flex-wrap justify-end gap-1 rounded-md bg-background/80 p-1 shadow-sm backdrop-blur-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
      >
        <Tooltip v-for="action in toolbarActions" :key="action.id">
          <TooltipTrigger as-child>
            <button
              type="button"
              class="flex size-7 items-center justify-center rounded-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
              :aria-label="action.label"
              @click="emit('action', action.id)"
            >
              <component :is="action.icon" class="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ action.label }}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
  </div>
</template>

<script setup lang="ts">
import { computed, type Component, type StyleValue } from 'vue'
import {
  ArrowDownTrayIcon,
  DocumentDuplicateIcon,
  ExclamationTriangleIcon,
  FilmIcon,
  FolderOpenIcon,
  InformationCircleIcon,
  MagnifyingGlassPlusIcon,
  NoSymbolIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import ArtifactProgress from '@/components/ArtifactProgress.vue'
import Model3DViewer from '@/components/Model3DViewer.vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ArtifactAction, TurnArtifact } from '@/lib/turnArtifacts'
import { hasDisplayableMedia, is3D, isVideo } from '@/types/mediaItem'

/** One image, video or 3D model in its frame, with its progress and its actions. */
const props = defineProps<{ artifact: TurnArtifact }>()

const emit = defineEmits<{ action: [action: ArtifactAction] }>()

const languages = useI18N().state

const unfinished = computed(
  () => props.artifact.state === 'failed' || props.artifact.state === 'cancelled',
)

/** Never wider than asked for, never taller than 70% of the window, in the requested aspect. */
const MAX_HEIGHT = '70vh'
const frameStyle = computed<StyleValue>(() => {
  const artifact = props.artifact
  const needsBox = is3D(artifact.item) || !hasDisplayableMedia(artifact.item) || unfinished.value
  const size = artifact.size ?? (needsBox ? { width: 512, height: 512 } : undefined)
  if (!size) return { maxHeight: MAX_HEIGHT }
  const ratio = size.width / size.height
  return {
    aspectRatio: `${size.width} / ${size.height}`,
    width: `min(100%, ${size.width}px, calc(${MAX_HEIGHT} * ${ratio}))`,
  }
})

const ACTIONS: Record<ArtifactAction, { icon: Component; label: () => string }> = {
  info: { icon: InformationCircleIcon, label: () => languages.COM_OPEN_PARAMS },
  zoom: { icon: MagnifyingGlassPlusIcon, label: () => languages.COM_ZOOM_IN },
  copy: { icon: DocumentDuplicateIcon, label: () => languages.COM_COPY },
  download: { icon: ArrowDownTrayIcon, label: () => languages.COM_DOWNLOAD },
  openFolder: { icon: FolderOpenIcon, label: () => languages.COM_OPEN_LOCATION },
  sendToEdit: { icon: PencilSquareIcon, label: () => languages.COM_POST_TO_IMAGE_EDIT },
  sendToVideo: { icon: FilmIcon, label: () => languages.COM_POST_TO_VIDEO },
  delete: { icon: TrashIcon, label: () => languages.ARTIFACT_DELETE },
}

const toolbarActions = computed(() =>
  props.artifact.actions.map((id) => ({ id, icon: ACTIONS[id].icon, label: ACTIONS[id].label() })),
)

function drag(event: Event) {
  event.preventDefault()
  if (props.artifact.state === 'done') window.electronAPI.startDrag(props.artifact.url)
}
</script>
