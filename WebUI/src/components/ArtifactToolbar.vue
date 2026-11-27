<template>
  <div
    v-if="actions.length > 0"
    role="toolbar"
    :aria-label="languages.ARTIFACT_ACTIONS"
    class="flex gap-1"
  >
    <TooltipProvider :delay-duration="200">
      <Tooltip v-for="action in actions" :key="action">
        <TooltipTrigger as-child>
          <button
            type="button"
            class="flex size-7 items-center justify-center rounded-sm text-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-primary"
            :aria-label="artifactActionLabel(action)"
            @click="emit('action', action)"
          >
            <component :is="ICONS[action]" class="size-4" />
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{{ artifactActionLabel(action) }}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  </div>
</template>

<script setup lang="ts">
import type { Component } from 'vue'
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
import { useI18N } from '@/assets/js/store/i18n'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { ArtifactAction } from '@/lib/turnArtifacts'
import { useArtifactActions } from '@/lib/useArtifactActions'

defineProps<{ actions: ArtifactAction[] }>()

const emit = defineEmits<{ action: [action: ArtifactAction] }>()

const languages = useI18N().state
const { label: artifactActionLabel } = useArtifactActions()

const ICONS: Record<ArtifactAction, Component> = {
  info: InformationCircleIcon,
  zoom: MagnifyingGlassPlusIcon,
  copy: DocumentDuplicateIcon,
  download: ArrowDownTrayIcon,
  openFolder: FolderOpenIcon,
  sendToEdit: PencilSquareIcon,
  sendToVideo: FilmIcon,
  delete: TrashIcon,
}
</script>
