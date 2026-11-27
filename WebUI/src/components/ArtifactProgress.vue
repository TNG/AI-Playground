<template>
  <div
    role="status"
    class="absolute inset-x-2 bottom-2 flex flex-col gap-1.5 rounded-md bg-background/80 px-3 py-2 text-xs text-foreground shadow-sm backdrop-blur-sm"
  >
    <div class="flex items-center justify-between gap-2">
      <span class="truncate">{{ label }}</span>
      <span v-if="progress" class="tabular-nums text-muted-foreground">
        {{ progress.current }}/{{ progress.max }}
      </span>
    </div>
    <div class="h-1 overflow-hidden rounded-full bg-muted">
      <div
        class="h-full rounded-full bg-primary transition-[width] duration-300"
        :class="{ 'animate-pulse': fraction === null }"
        :style="{ width: `${(fraction ?? 1) * 100}%` }"
      ></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { artifactPhaseLabel } from '@/lib/artifactRunProjection'
import type { ArtifactProgress } from '@/lib/turnArtifacts'
import type { ArtifactPhase } from '@/types/kernelEvents'

const props = defineProps<{ phase?: ArtifactPhase; progress?: ArtifactProgress }>()

const languages = useI18N().state

const label = computed(
  () => artifactPhaseLabel(props.phase, undefined, languages) ?? languages.COM_GENERATING,
)

const fraction = computed(() =>
  props.progress && props.progress.max > 0
    ? Math.min(1, props.progress.current / props.progress.max)
    : null,
)
</script>
