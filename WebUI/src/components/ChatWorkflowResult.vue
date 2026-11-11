<template>
  <div v-if="artifacts.length > 0" ref="anchor" class="w-full min-w-0">
    <div class="relative">
      <div class="mx-auto grid items-start" :style="gridStyle">
        <div
          v-for="artifact in artifacts"
          :key="artifact.id"
          class="flex w-full min-w-0 justify-center"
        >
          <ArtifactCard :artifact="artifact" @action="(action) => runAction(action, artifact)" />
        </div>
      </div>
      <info-table
        v-if="infoArtifact"
        class="inset-x-0 top-0 z-10 mx-auto max-w-full"
        :generationParameters="infoArtifact.item.settings ?? {}"
        :dynamicInputs="infoArtifact.item.dynamicSettings as any"
        @close="infoId = null"
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
import { computed, onBeforeUnmount, ref, watch, type StyleValue } from 'vue'
import { useElementSize } from '@vueuse/core'
import { useGallery } from '@/assets/js/store/gallery'
import { useI18N } from '@/assets/js/store/i18n'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { usePromptStore } from '@/assets/js/store/promptArea'
import ArtifactCard from '@/components/ArtifactCard.vue'
import DeleteArtifactDialog from '@/components/DeleteArtifactDialog.vue'
import InfoTable from '@/components/InfoTable.vue'
import * as toast from '@/assets/js/toast'
import * as util from '@/assets/js/util'
import {
  ARTIFACT_GRID_GAP_PX,
  artifactGrid,
  artifactGridWidth,
  type ArtifactAction,
  type TurnArtifact,
} from '@/lib/turnArtifacts'
import { useArtifactActions } from '@/lib/useArtifactActions'

const props = defineProps<{ artifacts: TurnArtifact[] }>()

const languages = useI18N().state
const { reportFailure } = useArtifactActions()
const gallery = useGallery()
const imageGeneration = useImageGenerationPresets()
const promptStore = usePromptStore()
const anchor = ref<HTMLElement | null>(null)
const { width: anchorWidth } = useElementSize(anchor)
const gridWidth = ref(0)
let pendingFrame = 0
// Next frame, so a column change never resizes the layout inside the ResizeObserver callback.
watch(anchorWidth, (measured) => {
  cancelAnimationFrame(pendingFrame)
  pendingFrame = requestAnimationFrame(() => {
    gridWidth.value = artifactGridWidth(props.artifacts, gridWidth.value, measured)
  })
})
onBeforeUnmount(() => cancelAnimationFrame(pendingFrame))
const infoId = ref<string | null>(null)
const confirmingDelete = ref<string | null>(null)

const infoArtifact = computed(
  () => props.artifacts.find((artifact) => artifact.id === infoId.value) ?? null,
)

const gridStyle = computed<StyleValue>(() => {
  const grid = artifactGrid(props.artifacts, gridWidth.value)
  return {
    gap: `${ARTIFACT_GRID_GAP_PX}px`,
    gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
    ...(grid.maxWidth ? { maxWidth: `${grid.maxWidth}px` } : {}),
  }
})

async function runAction(action: ArtifactAction, artifact: TurnArtifact) {
  try {
    switch (action) {
      case 'info':
        infoId.value = artifact.id
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
    reportFailure(action, error)
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
</script>
