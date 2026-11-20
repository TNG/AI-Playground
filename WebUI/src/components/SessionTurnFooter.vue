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
          :disabled="actionsBlocked"
          :class="{ 'opacity-50 cursor-not-allowed': actionsBlocked }"
          @click="regenerate()"
        >
          <ArrowPathIcon class="size-4" aria-hidden="true" />
          <span class="text-xs ml-1">{{ languages.COM_REGENERATE }}</span>
        </button>
        <button
          v-else-if="action === 'edit'"
          class="flex items-center"
          :disabled="actionsBlocked"
          :class="{ 'opacity-50 cursor-not-allowed': actionsBlocked }"
          @click="emit('edit')"
        >
          <PencilSquareIcon class="size-4" aria-hidden="true" />
          <span class="text-xs ml-1">{{ languages.COM_EDIT }}</span>
        </button>
        <button
          v-else-if="action === 'delete'"
          class="flex items-center"
          :disabled="actionsBlocked"
          :class="{ 'opacity-50 cursor-not-allowed': actionsBlocked }"
          @click="remove()"
        >
          <TrashIcon class="size-4" aria-hidden="true" />
          <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
        </button>
        <button v-else-if="action === 'hide'" class="flex items-center" @click="hideTurn">
          <EyeSlashIcon class="size-4" aria-hidden="true" />
          <span class="text-xs ml-1">{{ languages.COM_HIDE }}</span>
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
  EyeSlashIcon,
  PencilSquareIcon,
  SpeakerWaveIcon,
  StopIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useDialogStore } from '@/assets/js/store/dialogs'
import { useMessageHiding } from '@/assets/js/store/messageHiding'
import { useSessions } from '@/assets/js/store/sessions'
import { useErrors } from '@/assets/js/store/errors'
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
import type { TurnFooter } from '@/lib/turnTypes'
import { useTurnActions } from '@/lib/useTurnActions'

const props = defineProps<{ footer: TurnFooter }>()

/** Edit opens the prompt bubble's editor; the turn block runs it. */
const emit = defineEmits<{ edit: [] }>()

const openAiCompatibleChat = useOpenAiCompatibleChat()
const { blocked: actionsBlocked, regenerate, remove } = useTurnActions(() => props.footer)
const sessions = useSessions()
const messageHiding = useMessageHiding()
const dialogs = useDialogStore()
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

async function hideTurn(): Promise<void> {
  if (!messageHiding.enabled) return
  const sessionId = sessions.openSessionId
  const hiding = props.footer.hiding
  if (!sessionId || !hiding) return
  const confirmed = await dialogs.requestConfirmation(languages.SESSION_TURN_HIDE_CONFIRM, {
    confirm: languages.COM_OK,
    cancel: languages.COM_CANCEL,
  })
  if (!confirmed) return
  try {
    await sessions.hideTimelineMessages(sessionId, hiding.messageIds)
  } catch (error) {
    errors.report(error, {
      category: 'backend',
      code: 'sessions/hide-turn-failed',
      surface: 'toast',
    })
  }
}
</script>
