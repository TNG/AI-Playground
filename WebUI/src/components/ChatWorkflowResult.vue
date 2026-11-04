<template>
  <div v-if="processing || currentArtifact" class="flex flex-col gap-3">
    <!-- Horizontal Thumbnail Gallery -->
    <div v-if="artifacts.length > 1" class="flex gap-2 overflow-x-auto pb-2">
      <div
        v-for="artifact in artifacts"
        :key="artifact.id"
        class="flex-shrink-0 cursor-pointer relative border-3 shadow-foreground/40 shadow-md transition-colors rounded-sm overflow-hidden"
        :class="selectedId === artifact.id ? 'border-primary' : 'border-transparent'"
        @click="selectedId = artifact.id"
        style="width: 80px; height: 60px"
      >
        <div
          class="relative w-full h-full flex items-center justify-center bg-background"
          :draggable="artifact.state === 'done'"
          @dragstart="(e) => dragArtifact(e, artifact)"
        >
          <div
            v-if="artifact.state === 'deleted'"
            class="w-full h-full bg-muted"
            :aria-label="languages.SESSION_FILE_DELETED"
          ></div>
          <video
            v-else-if="isVideo(artifact.item)"
            :src="artifact.item.videoUrl"
            class="w-full h-full object-cover"
          />
          <Model3DViewer
            v-else-if="is3D(artifact.item)"
            :src="artifact.item.model3dUrl"
            class="w-full h-full"
          />
          <img
            v-else-if="artifact.item.type === 'image' && hasDisplayableMedia(artifact.item)"
            :src="artifact.item.imageUrl"
            class="w-full h-full object-cover"
          />

          <div
            v-if="artifact.state === 'running'"
            class="absolute inset-0 bg-background/60 flex items-center justify-center"
          >
            <span class="svg-icon i-loading w-4 h-4 animate-spin"></span>
          </div>
        </div>
      </div>
    </div>

    <div class="flex justify-center items-center relative">
      <div class="group relative bg-accent rounded-lg min-w-[400px] min-h-[300px]">
        <div
          v-if="currentArtifact"
          class="flex justify-center items-center"
          :draggable="currentArtifact.state === 'done' && !is3D(currentArtifact.item)"
          @dragstart="(e) => currentArtifact && dragArtifact(e, currentArtifact)"
        >
          <div
            v-if="currentArtifact.state === 'deleted'"
            role="status"
            class="flex items-center justify-center w-[400px] h-[300px] text-muted-foreground"
          >
            {{ languages.SESSION_FILE_DELETED }}
          </div>
          <div
            v-else-if="
              currentArtifact.item.type === 'image' && !hasDisplayableMedia(currentArtifact.item)
            "
            class="flex items-center justify-center bg-gradient-to-br from-accent/30 to-muted/20 w-[400px] h-[300px] rounded-sm"
          >
            <div class="flex flex-col items-center justify-center gap-4">
              <Spinner class="w-16 h-16 text-primary/40" />
            </div>
          </div>
          <img
            v-else-if="currentArtifact.item.type === 'image'"
            alt="Generated result"
            class="object-contain shadow-black/40 shadow-md rounded-sm border-3 border-background"
            :src="currentArtifact.url"
          />
          <video
            v-else-if="isVideo(currentArtifact.item)"
            :src="currentArtifact.url"
            aria-label="Generated result"
            class="object-contain p-2"
            controlsList="nodownload nofullscreen noremoteplayback"
            controls
          />
          <!-- model-viewer sizes to 100% of its parent, so it needs an explicit box. -->
          <div
            v-else-if="is3D(currentArtifact.item)"
            class="w-[400px] h-[400px]"
            role="img"
            aria-label="Generated 3D model"
          >
            <Model3DViewer :src="currentArtifact.url" />
          </div>
        </div>

        <div
          v-show="processing"
          class="absolute inset-0 flex justify-center items-center rounded-lg"
        >
          <loading-bar v-if="phase !== 'running'" :text="phaseLabel" class="w-3/4"></loading-bar>
          <ImageGenerationProgress v-else :step-text="phaseLabel" />
        </div>

        <TooltipProvider :delay-duration="200">
          <div
            v-if="currentArtifact && toolbarActions.length > 0"
            role="toolbar"
            :aria-label="languages.ARTIFACT_ACTIONS"
            class="absolute top-2 right-2 flex gap-1 rounded-md bg-background/80 p-1 shadow-sm backdrop-blur-sm opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          >
            <Tooltip v-for="action in toolbarActions" :key="action.id">
              <TooltipTrigger as-child>
                <button
                  type="button"
                  class="flex size-7 items-center justify-center rounded-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
                  :aria-label="action.label"
                  @click="runAction(action.id, currentArtifact)"
                >
                  <component :is="action.icon" class="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{{ action.label }}</TooltipContent>
            </Tooltip>
          </div>
        </TooltipProvider>
      </div>
      <info-table
        v-show="showInfoParams"
        :generationParameters="currentArtifact?.item.settings ?? {}"
        :dynamicInputs="currentArtifact?.item.dynamicSettings as any"
        @close="showInfoParams = false"
      ></info-table>
    </div>
    <DeleteArtifactDialog
      :open="confirmingDelete !== null"
      @update:open="(open) => !open && (confirmingDelete = null)"
      @confirm="confirmDelete"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, type Component } from 'vue'
import {
  ArrowDownTrayIcon,
  DocumentDuplicateIcon,
  FilmIcon,
  FolderOpenIcon,
  InformationCircleIcon,
  MagnifyingGlassPlusIcon,
  PencilSquareIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { useErrors } from '@/assets/js/store/errors'
import { useGallery } from '@/assets/js/store/gallery'
import { useI18N } from '@/assets/js/store/i18n'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { usePromptStore } from '@/assets/js/store/promptArea'
import DeleteArtifactDialog from '@/components/DeleteArtifactDialog.vue'
import ImageGenerationProgress from '@/components/ImageGenerationProgress.vue'
import InfoTable from '@/components/InfoTable.vue'
import LoadingBar from '@/components/LoadingBar.vue'
import Model3DViewer from '@/components/Model3DViewer.vue'
import { Spinner } from '@/components/ui/spinner'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import * as toast from '@/assets/js/toast'
import * as util from '@/assets/js/util'
import { artifactPhaseLabel, isTerminalPhase } from '@/lib/artifactRunProjection'
import type { ArtifactAction, TurnArtifact } from '@/lib/turnArtifacts'
import type { ArtifactPhase } from '@/types/kernelEvents'
import { hasDisplayableMedia, is3D, isVideo } from '@/types/mediaItem'

/** The one artifact card: every image, video and 3D model a Turn shows, whoever made it. */
const props = defineProps<{
  artifacts: TurnArtifact[]
  /** Phase of the owning run in flight; absent once nothing is running. */
  phase?: ArtifactPhase
  progress?: { current: number; max: number }
}>()

const languages = useI18N().state
const errors = useErrors()
const gallery = useGallery()
const imageGeneration = useImageGenerationPresets()
const promptStore = usePromptStore()
const showInfoParams = ref(false)
const confirmingDelete = ref<string | null>(null)
const selectedId = ref<string | null>(null)

const processing = computed(() => !!props.phase && !isTerminalPhase(props.phase))
const phaseLabel = computed(
  () => artifactPhaseLabel(props.phase, props.progress, languages) ?? languages.COM_GENERATING,
)

watch(
  () => props.artifacts.map((artifact) => artifact.id),
  (ids) => {
    if (!selectedId.value || !ids.includes(selectedId.value)) selectedId.value = ids.at(-1) ?? null
  },
  { immediate: true },
)

const currentArtifact = computed(
  () => props.artifacts.find((artifact) => artifact.id === selectedId.value) ?? null,
)

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
  (processing.value ? [] : (currentArtifact.value?.actions ?? [])).map((id) => ({
    id,
    icon: ACTIONS[id].icon,
    label: ACTIONS[id].label(),
  })),
)

async function runAction(action: ArtifactAction, artifact: TurnArtifact) {
  try {
    switch (action) {
      case 'info':
        showInfoParams.value = true
        return
      case 'zoom':
        return window.electronAPI.openImageWithSystem(artifact.url)
      case 'copy':
        await util.copyImage(artifact.url)
        return toast.success(languages.COM_COPY_SUCCESS_TIP)
      case 'download': {
        const result = await window.electronAPI.saveMediaCopy(artifact.url)
        if (!result.success) throw new Error(result.error)
        return
      }
      case 'openFolder':
        return window.electronAPI.openImageInFolder(artifact.url)
      case 'sendToEdit':
        return await sendToMode(artifact, 'imageEdit')
      case 'sendToVideo':
        return await sendToMode(artifact, 'video')
      case 'delete':
        confirmingDelete.value = artifact.url
        return
    }
  } catch (error) {
    errors.report(error, { code: `artifact/${action}-failed`, surface: 'toast' })
  }
}

async function sendToMode(artifact: TurnArtifact, mode: WorkflowModeType) {
  await imageGeneration.copyImageAsInputForMode(artifact.item, mode)
  promptStore.setCurrentMode(mode)
}

async function confirmDelete() {
  const url = confirmingDelete.value
  confirmingDelete.value = null
  if (url) await gallery.removeByUrl(url)
}

function dragArtifact(event: Event, artifact: TurnArtifact) {
  event.preventDefault()
  if (artifact.state === 'done') window.electronAPI.startDrag(artifact.url)
}
</script>
