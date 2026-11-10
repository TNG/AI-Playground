<template>
  <div class="flex flex-col gap-1">
    <div v-if="shownActions.length" class="flex gap-3 items-center text-muted-foreground">
      <template v-for="action in shownActions" :key="action">
        <button v-if="action === 'copy'" class="flex items-center" @click="copyText">
          <DocumentDuplicateIcon class="size-4" aria-hidden="true" />
          <span class="text-xs ml-1">{{ languages.COM_COPY }}</span>
        </button>
        <button
          v-else-if="action === 'speak'"
          class="flex items-center"
          :disabled="speakBlocked"
          :class="{ 'opacity-50 cursor-not-allowed': speakBlocked }"
          @click="toggleSpeak"
        >
          <ArrowPathIcon v-if="startingSpeech" class="size-4 animate-spin" aria-hidden="true" />
          <StopIcon v-else-if="speakingThis" class="size-4" aria-hidden="true" />
          <SpeakerWaveIcon v-else class="size-4" aria-hidden="true" />
          <span class="text-xs ml-1">{{ speakLabel }}</span>
        </button>
        <button
          v-else-if="action === 'regenerate'"
          class="flex items-center"
          :disabled="regenerateBlocked"
          :class="{ 'opacity-50 cursor-not-allowed': regenerateBlocked }"
          @click="regenerate"
        >
          <ArrowPathIcon class="size-4" aria-hidden="true" />
          <span class="text-xs ml-1">{{ languages.COM_REGENERATE }}</span>
        </button>
        <button v-else-if="action === 'delete'" class="flex items-center" @click="remove">
          <TrashIcon class="size-4" aria-hidden="true" />
          <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
        </button>
      </template>
    </div>
    <div v-if="metricsShown && metricLines.length" class="text-xs text-muted-foreground">
      {{ metricLines.join(' ⋅ ') }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  ArrowPathIcon,
  DocumentDuplicateIcon,
  SpeakerWaveIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useImageGenerationPresets } from '@/assets/js/store/imageGenerationPresets'
import { useErrors } from '@/assets/js/store/errors'
import { isCancellation } from '@/assets/js/errors/appError'
import { useTextInference } from '@/assets/js/store/textInference'
import {
  isSpeaking,
  preparingSpeech,
  speak,
  speakRepliesAvailable,
  speakingMessageId,
  stopSpeaking,
} from '@/assets/js/speech/speechIO'
import { CHAT_ENERGY_ESTIMATES_ENABLED, estimateConversationEnergy } from '@/lib/chatEnergy'
import { copyToClipboard } from '@/lib/chatMessageText'
import { formatEnergyWh, formatMib, formatUsd } from '@/lib/computeMetricsFormat'
import { fillTemplate } from '@/lib/fillTemplate'
import type { MediaRerun, TurnFooter } from '@/lib/turnTypes'

const props = defineProps<{ footer: TurnFooter }>()

const openAiCompatibleChat = useOpenAiCompatibleChat()
const agentMode = useAgentMode()
const imageGeneration = useImageGenerationPresets()
const errors = useErrors()
const textInference = useTextInference()
const languages = useI18N().state

const shownActions = computed(() =>
  props.footer.actions.filter((action) => action !== 'speak' || speakRepliesAvailable()),
)
const metricsShown = computed(() => textInference.metricsEnabled)
const newestAnswer = computed(
  () => props.footer.actions.includes('regenerate') && !props.footer.rerun,
)
const regenerateBlocked = computed(
  () => openAiCompatibleChat.processing || (!!props.footer.rerun && imageGeneration.processing),
)
const conversationEnergy = computed(() =>
  estimateConversationEnergy(openAiCompatibleChat.messages ?? []),
)

const speakingThis = computed(() => speakingMessageId.value === props.footer.messageId)
const startingSpeech = computed(
  () => preparingSpeech.value && speakingThis.value && !isSpeaking.value,
)
const speakBlocked = computed(
  () => openAiCompatibleChat.processing || (preparingSpeech.value && !speakingThis.value),
)

const speakLabel = computed(() => {
  if (startingSpeech.value) return languages.SESSION_TURN_SPEECH_STARTING
  return speakingThis.value && isSpeaking.value ? languages.COM_STOP : languages.SESSION_TURN_SPEAK
})

const metricLines = computed(() => {
  const metrics = props.footer.metrics
  const timings = metrics?.timings
  if (!timings) return []
  const lines = [
    fillTemplate(languages.SESSION_TURN_METRIC_TOKENS, { count: String(timings.predicted_n) }),
    fillTemplate(languages.SESSION_TURN_METRIC_TOKENS_PER_SECOND, {
      rate: timings.predicted_per_second.toFixed(2),
    }),
    fillTemplate(languages.SESSION_TURN_METRIC_FIRST_TOKEN, { ms: timings.prompt_ms.toFixed(2) }),
  ]
  const gpuPeak = metrics.compute?.gpuMemPeakMiB
  const hostPeak = metrics.compute?.hostMemPeakMiB
  if (gpuPeak != null) {
    lines.push(fillTemplate(languages.SESSION_TURN_METRIC_VRAM_PEAK, { size: formatMib(gpuPeak) }))
  } else if (hostPeak != null) {
    lines.push(fillTemplate(languages.SESSION_TURN_METRIC_RAM_PEAK, { size: formatMib(hostPeak) }))
  }
  const wattHours = metrics.energy?.wattHours
  if (CHAT_ENERGY_ESTIMATES_ENABLED && wattHours != null) {
    lines.push(
      fillTemplate(languages.SESSION_TURN_METRIC_GPU_ENERGY, { energy: formatEnergyWh(wattHours) }),
    )
  }
  if (CHAT_ENERGY_ESTIMATES_ENABLED && newestAnswer.value && conversationEnergy.value) {
    lines.push(
      fillTemplate(languages.SESSION_TURN_METRIC_COST_ESTIMATE, {
        cost: formatUsd(conversationEnergy.value.costPerMillionOutputTokensUsd),
      }),
    )
  }
  return lines
})

function copyText() {
  copyToClipboard(props.footer.text, languages.COM_COPY_SUCCESS_TIP)
}

function toggleSpeak() {
  const messageId = props.footer.messageId
  if (!messageId) return
  if (speakingThis.value && (isSpeaking.value || preparingSpeech.value)) {
    stopSpeaking()
    return
  }
  if (preparingSpeech.value) return
  void speak({ text: props.footer.text, messageId })
}

async function rerunMedia(rerun: MediaRerun) {
  try {
    await imageGeneration.regenerate(rerun)
  } catch (error) {
    if (isCancellation(error)) return
    errors.report(error, {
      category: 'generation',
      code: 'generation/submit-failed',
      userMessage: languages.SESSION_IMAGE_GENERATION_FAILED,
    })
  }
}

function regenerate() {
  if (props.footer.rerun) void rerunMedia(props.footer.rerun)
  else if (props.footer.messageId) void openAiCompatibleChat.regenerate(props.footer.messageId)
}

function remove() {
  if (props.footer.harnessTurn) void agentMode.deleteTurns(props.footer.harnessTurn)
  else if (props.footer.messageId) void openAiCompatibleChat.removeMessage(props.footer.messageId)
}
</script>
