<template>
  <TaskRunBlock v-if="item.kind === 'task-run'" :task-run="item.taskRun">
    <SessionTurnBlock
      v-for="turn in item.turns"
      :key="turn.id"
      :item="turn"
      :last-chat-message-id="lastChatMessageId"
      :chat-key="chatKey"
    />
  </TaskRunBlock>
  <div
    v-else-if="item.kind === 'message'"
    class="text-sm text-muted-foreground whitespace-pre-wrap"
    :class="item.message.role === 'user' ? 'self-end' : 'self-start'"
  >
    {{ plainText(item.message) }}
  </div>
  <SessionTurn v-else :hint="item.hint">
    <template v-if="item.prompt" #prompt>
      <SessionTurnPrompt
        :prompt="item.prompt"
        :queued="item.kind === 'agent' && item.queued"
        :not-run="item.kind === 'agent' && item.notRun"
        :can-resend="item.kind === 'agent' && item.canResend"
        @resend="emit('resend')"
      />
    </template>
    <template #result>
      <SessionMessage
        v-for="answer in item.kind === 'chat' ? item.answers : []"
        :key="answer.id"
        :message="answer"
        engine="chat"
        unlabelled
        footerless
        :last="answer.id === lastChatMessageId"
        :conversation-key="chatKey"
      />
      <SessionMessage
        v-for="answer in item.kind === 'agent' ? item.answers : []"
        :key="answer.id"
        :message="answer"
        engine="agent"
        unlabelled
        :live="item.kind === 'agent' && !!item.streaming && answer.id === item.answers.at(-1)?.id"
      />
      <MediaTurnBlock
        v-if="item.kind === 'media'"
        :artifacts="item.artifacts"
        :status="item.media.status"
        :error="item.media.error"
      />
      <MediaTurnBlock
        v-else-if="item.kind === 'pending-media'"
        :artifacts="turnArtifacts(artifactRuns.state.runs[item.pending.runId]?.items ?? [], [])"
        :phase="artifactRuns.state.runs[item.pending.runId]?.phase ?? 'queued'"
        :progress="artifactRuns.state.runs[item.pending.runId]?.progress"
      />
      <AudioTurnBlock
        v-else-if="item.kind === 'audio'"
        :kind="item.audio.kind"
        :audio-url="item.audio.audioUrl"
        :transcript="item.audio.transcript"
        :status="item.audio.status"
        :error="item.audio.error"
        :file-deleted="audioFileDeleted"
      />
      <AudioTurnBlock
        v-else-if="item.kind === 'pending-audio'"
        :kind="item.pending.kind"
        :phase="item.pending.phase"
      />
    </template>
    <template v-if="footerShown" #footer>
      <SessionTurnFooter :footer="item.footer" />
    </template>
  </SessionTurn>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import type { PendingAudioTurn } from '@/assets/js/store/sessionAudio'
import { useSessions, type PendingMediaTurn } from '@/assets/js/store/sessions'
import { useTextInference } from '@/assets/js/store/textInference'
import AudioTurnBlock from '@/components/AudioTurnBlock.vue'
import MediaTurnBlock from '@/components/MediaTurnBlock.vue'
import SessionMessage from '@/components/SessionMessage.vue'
import SessionTurn from '@/components/SessionTurn.vue'
import SessionTurnFooter from '@/components/SessionTurnFooter.vue'
import SessionTurnPrompt from '@/components/SessionTurnPrompt.vue'
import TaskRunBlock from '@/components/TaskRunBlock.vue'
import type { SessionTimelineItem } from '@/lib/sessionTimeline'
import { turnArtifacts } from '@/lib/turnArtifacts'
import type { TimelineMessage } from '@/types/sessionTimeline'

/** One entry of the Session timeline: a Turn, settled or running, or a Task Run of Turns. */
const props = defineProps<{
  item: SessionTimelineItem<PendingMediaTurn, PendingAudioTurn>
  /** The newest message of the Session's live chat transcript. */
  lastChatMessageId?: string
  chatKey: string
}>()

const emit = defineEmits<{ resend: [] }>()

const sessions = useSessions()
const artifactRuns = useArtifactRuns()
const textInference = useTextInference()

const footerShown = computed(() => {
  if (props.item.kind === 'task-run' || props.item.kind === 'message') return false
  const footer = props.item.footer
  return footer.actions.length > 0 || (textInference.metricsEnabled && !!footer.metrics)
})

const audioFileDeleted = computed(
  () =>
    props.item.kind === 'audio' &&
    !!props.item.audio.audioUrl &&
    sessions.isFileDeleted(props.item.audio.audioUrl),
)

function plainText(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}
</script>
