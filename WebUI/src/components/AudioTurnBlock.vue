<template>
  <SessionAssistantBubble>
    <p v-if="phase" role="status" class="text-sm text-muted-foreground animate-pulse">
      {{ phaseLabel }}
    </p>
    <template v-else-if="status === 'completed'">
      <p v-if="kind === 'tts' && fileDeleted" class="text-sm text-muted-foreground">
        {{ languages.SESSION_FILE_DELETED }}
      </p>
      <audio
        v-else-if="kind === 'tts' && audioUrl"
        controls
        class="w-full max-w-md"
        :src="audioUrl"
        aria-label="Generated speech"
      />
      <p v-if="kind === 'stt'" class="whitespace-pre-wrap wrap-break-word">
        {{ transcript }}
      </p>
    </template>
    <p v-else-if="status === 'failed'" class="text-sm text-red-500 wrap-break-word">
      {{ kind === 'tts' ? languages.SESSION_AUDIO_TTS_FAILED : languages.SESSION_AUDIO_STT_FAILED
      }}<template v-if="error">: {{ error }}</template>
    </p>
    <p v-else-if="status === 'cancelled'" class="text-sm text-muted-foreground">
      {{ languages.SESSION_AUDIO_CANCELLED }}
    </p>
  </SessionAssistantBubble>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import { useI18N } from '@/assets/js/store/i18n'
import type { AudioTurnPhase } from '@/assets/js/store/sessionAudio'
import type { AudioTurnData, MediaTurnStatus } from '@/types/sessionTimeline'

/** The Result of a Text-to-Speech or Speech-to-Text Turn, settled or still running. */
const props = defineProps<{
  kind: AudioTurnData['kind']
  audioUrl?: string
  transcript?: string
  /** Set only while the turn is running. */
  phase?: AudioTurnPhase
  status?: MediaTurnStatus
  error?: string
  fileDeleted?: boolean
}>()

const languages = useI18N().state

const phaseLabel = computed(() => {
  if (props.phase === 'loading-model') return languages.SESSION_AUDIO_LOADING_VOICE
  if (props.phase === 'generating') return languages.SESSION_AUDIO_GENERATING
  return languages.SESSION_AUDIO_TRANSCRIBING
})
</script>
