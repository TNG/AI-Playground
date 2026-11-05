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
    <ArrowPathIcon v-if="live" class="size-3.5 flex-none animate-spin" aria-hidden="true" />
    <span class="truncate">{{ text }}</span>
    <span v-if="percent !== undefined" class="flex-none tabular-nums opacity-70">
      {{ percent }}%
    </span>
  </button>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ArrowPathIcon, ChevronRightIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { fillTemplate } from '@/lib/fillTemplate'
import { turnDetailsSummaryText, turnLiveText } from '@/lib/turnText'
import type { TurnLiveStatus, TurnSummary } from '@/lib/turnTypes'

const props = defineProps<{ summary: TurnSummary; live?: TurnLiveStatus; open: boolean }>()

const languages = useI18N().state

const text = computed(() => liveText.value ?? (summaryText.value || languages.SESSION_TURN_DETAILS))

const percent = computed(() => {
  const live = props.live
  if (!live || !('progress' in live) || typeof live.progress !== 'number') return undefined
  return Math.round(live.progress * 100)
})

const liveText = computed(() =>
  props.live
    ? turnLiveText(props.live, {
        reasoning: languages.SESSION_TURN_LIVE_REASONING,
        writing: languages.SESSION_TURN_LIVE_WRITING,
        working: languages.SESSION_TURN_LIVE_WORKING,
        runningTool: languages.COM_ACTIVITY_RUNNING_TOOL,
        queued: languages.AGENT_TURN_QUEUED_DETAIL,
        audioLoading: languages.SESSION_AUDIO_LOADING_VOICE,
        audioGenerating: languages.SESSION_AUDIO_GENERATING,
        audioTranscribing: languages.SESSION_AUDIO_TRANSCRIBING,
        artifact: languages,
      })
    : undefined,
)

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
    agentRunStep: languages.SESSION_TURN_DETAILS_AGENT_RUN_STEP,
    agentRunSteps: languages.SESSION_TURN_DETAILS_AGENT_RUN_STEPS,
  }),
)
</script>
