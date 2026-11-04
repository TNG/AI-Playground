<template>
  <SessionAssistantBubble v-if="artifacts.length > 0 || !phase">
    <AudioArtifactCard v-for="artifact in artifacts" :key="artifact.id" :artifact="artifact" />
    <template v-if="kind === 'stt'">
      <p v-if="status === 'completed'" class="whitespace-pre-wrap wrap-break-word">
        {{ transcript }}
      </p>
      <p v-else-if="status === 'failed'" class="text-sm text-red-500 wrap-break-word">
        {{ languages.SESSION_AUDIO_STT_FAILED }}<template v-if="error">: {{ error }}</template>
      </p>
      <p v-else-if="status === 'cancelled'" class="text-sm text-muted-foreground">
        {{ languages.SESSION_AUDIO_CANCELLED }}
      </p>
    </template>
  </SessionAssistantBubble>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import AudioArtifactCard from '@/components/AudioArtifactCard.vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import type { AudioArtifact } from '@/lib/audioArtifacts'
import type { AudioPhase } from '@/lib/sessionTimeline'
import type { AudioTurnData, MediaTurnStatus } from '@/types/sessionTimeline'

/**
 * The Result of an audio Turn: a Text-to-Speech clip's card, or a Speech-to-Text transcript.
 * A transcription still running has no Result yet; its Turn Details header says how far it is.
 */
defineProps<{
  kind: AudioTurnData['kind']
  artifacts: AudioArtifact[]
  transcript?: string
  phase?: AudioPhase
  status?: MediaTurnStatus
  error?: string
}>()

const languages = useI18N().state
</script>
