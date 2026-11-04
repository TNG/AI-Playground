<template>
  <div class="flex flex-col gap-1">
    <div v-if="shownActions.length" class="flex gap-3 items-center text-muted-foreground">
      <template v-for="action in shownActions" :key="action">
        <button v-if="action === 'copy'" class="flex items-end" @click="copyText">
          <span class="svg-icon i-copy w-4 h-4" aria-hidden="true"></span>
          <span class="text-xs ml-1">{{ languages.COM_COPY }}</span>
        </button>
        <button
          v-else-if="action === 'speak'"
          class="flex items-end"
          :disabled="speakBlocked"
          :class="{ 'opacity-50 cursor-not-allowed': speakBlocked }"
          @click="toggleSpeak"
        >
          <span
            v-if="startingSpeech"
            class="svg-icon i-loading w-4 h-4 animate-spin"
            aria-hidden="true"
          ></span>
          <span
            v-else
            class="svg-icon w-4 h-4"
            :class="speakingThis ? 'i-stop' : 'i-speaker'"
            aria-hidden="true"
          ></span>
          <span class="text-xs ml-1">{{
            startingSpeech ? 'Starting…' : speakingThis && isSpeaking ? 'Stop' : 'Speak'
          }}</span>
        </button>
        <button
          v-else-if="action === 'regenerate'"
          class="flex items-end"
          :disabled="regenerateBlocked"
          :class="{ 'opacity-50 cursor-not-allowed': regenerateBlocked }"
          @click="regenerate"
        >
          <span class="svg-icon i-refresh w-4 h-4" aria-hidden="true"></span>
          <span class="text-xs ml-1">{{ languages.COM_REGENERATE }}</span>
        </button>
        <button v-else-if="action === 'delete'" class="flex items-end" @click="remove">
          <span class="svg-icon i-delete w-4 h-4" aria-hidden="true"></span>
          <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
        </button>
      </template>
    </div>
    <div v-if="metricsShown && footer.metrics?.timings" class="text-xs text-muted-foreground">
      <span class="mr-2">{{ footer.metrics.timings.predicted_n }} Tokens</span>
      <span class="mr-2">⋅</span>
      <span class="mr-2"
        >{{ footer.metrics.timings.predicted_per_second.toFixed(2) }} Tokens/s</span
      >
      <span class="mr-2">⋅</span>
      <span class="mr-2">1st Token Time: {{ footer.metrics.timings.prompt_ms.toFixed(2) }}ms</span>
      <template v-if="footer.metrics.compute?.gpuMemPeakMiB != null">
        <span class="mr-2">⋅</span>
        <span class="mr-2">{{ formatMib(footer.metrics.compute.gpuMemPeakMiB) }} vRAM peak</span>
      </template>
      <template v-else-if="footer.metrics.compute?.hostMemPeakMiB != null">
        <span class="mr-2">⋅</span>
        <span class="mr-2">{{ formatMib(footer.metrics.compute.hostMemPeakMiB) }} RAM peak</span>
      </template>
      <template v-if="CHAT_ENERGY_ESTIMATES_ENABLED && footer.metrics.energy?.wattHours != null">
        <span class="mr-2">⋅</span>
        <span class="mr-2">{{ formatEnergyWh(footer.metrics.energy.wattHours) }} GPU energy</span>
      </template>
      <template v-if="CHAT_ENERGY_ESTIMATES_ENABLED && newestAnswer && conversationEnergy">
        <span class="mr-2">⋅</span>
        <span class="mr-2"
          >est. {{ formatUsd(conversationEnergy.costPerMillionOutputTokensUsd) }} / 1M output tokens
          @ $0.35/kWh</span
        >
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
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
import type { MediaRerun, TurnFooter } from '@/lib/turnTypes'

/** The actions that apply to a Turn, and its metrics where it has them. */
const props = defineProps<{ footer: TurnFooter }>()

const openAiCompatibleChat = useOpenAiCompatibleChat()
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
    imageGeneration.processing = false
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
  if (props.footer.messageId) void openAiCompatibleChat.removeMessage(props.footer.messageId)
}
</script>
