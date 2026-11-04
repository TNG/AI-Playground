<template>
  <button
    type="button"
    :aria-label="fillTemplate(languages.SESSION_TURN_DETAILS_LABEL, { summary: text })"
    class="flex max-w-full items-center gap-1.5 self-start rounded-sm text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
  >
    <ChevronRightIcon
      class="size-3.5 flex-none transition-transform"
      :class="{ 'rotate-90': open }"
      aria-hidden="true"
    />
    <span class="truncate">{{ text }}</span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ChevronRightIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { fillTemplate } from '@/lib/notificationLabel'
import { turnDetailsSummaryText, type TurnSummary } from '@/lib/sessionTimeline'

/** The Turn Details toggle: one line saying what is inside it. */
const props = defineProps<{ summary: TurnSummary; open: boolean }>()

const languages = useI18N().state

const text = computed(() => summaryText.value || languages.SESSION_TURN_DETAILS)

const summaryText = computed(() =>
  turnDetailsSummaryText(props.summary, {
    reasoned: languages.SESSION_TURN_DETAILS_REASONED,
    reasonedUntimed: languages.SESSION_TURN_DETAILS_REASONED_UNTIMED,
    tool: languages.SESSION_TURN_DETAILS_TOOL,
    tools: languages.SESSION_TURN_DETAILS_TOOLS,
    image: languages.SESSION_TURN_DETAILS_IMAGE,
    images: languages.SESSION_TURN_DETAILS_IMAGES,
    video: languages.SESSION_TURN_DETAILS_VIDEO,
    videos: languages.SESSION_TURN_DETAILS_VIDEOS,
    model3d: languages.SESSION_TURN_DETAILS_MODEL3D,
    models3d: languages.SESSION_TURN_DETAILS_MODELS3D,
    audio: languages.SESSION_TURN_DETAILS_AUDIO,
    audios: languages.SESSION_TURN_DETAILS_AUDIOS,
    seed: languages.SESSION_TURN_DETAILS_SEED,
  }),
)
</script>
