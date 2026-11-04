<template>
  <TooltipProvider :delay-duration="200">
    <Tooltip>
      <TooltipTrigger as-child>
        <span
          role="note"
          tabindex="0"
          :aria-label="accessibleName"
          class="inline-flex min-w-0 items-center gap-1.5 rounded-sm text-xs text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <component :is="icon" class="size-3.5 flex-none" aria-hidden="true" />
          <span class="truncate">{{ hint.preset }}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent class="max-w-xs">{{ tooltip }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  ChatBubbleLeftRightIcon,
  CpuChipIcon,
  FilmIcon,
  MicrophoneIcon,
  PhotoIcon,
  SpeakerWaveIcon,
} from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import type { TurnHint, TurnHintIcon } from '@/lib/turnTypes'

const props = defineProps<{ hint: TurnHint }>()

const languages = useI18N().state

const ICONS = {
  chat: ChatBubbleLeftRightIcon,
  agent: CpuChipIcon,
  image: PhotoIcon,
  video: FilmIcon,
  tts: SpeakerWaveIcon,
  stt: MicrophoneIcon,
} satisfies Record<TurnHintIcon, unknown>

const icon = computed(() => ICONS[props.hint.icon])

const kindLabel = computed(
  () =>
    ({
      chat: languages.SESSION_TURN_HINT_CHAT,
      agent: languages.SESSION_TURN_HINT_AGENT,
      image: languages.SESSION_TURN_HINT_IMAGE,
      video: languages.SESSION_TURN_HINT_VIDEO,
      tts: languages.SESSION_TURN_HINT_TTS,
      stt: languages.SESSION_TURN_HINT_STT,
    })[props.hint.icon],
)

const tooltip = computed(() =>
  props.hint.detail ? `${kindLabel.value} · ${props.hint.detail}` : kindLabel.value,
)

const accessibleName = computed(() =>
  [
    languages.SESSION_TURN_HINT_LABEL.replace('{kind}', kindLabel.value).replace(
      '{preset}',
      props.hint.preset,
    ),
    props.hint.detail,
  ]
    .filter(Boolean)
    .join(', '),
)
</script>
