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
    <template #details>
      <TurnDetails :details="item.details">
        <template v-for="(part, index) in item.details.parts" :key="index">
          <p v-if="part.kind === 'workspace-path'" class="text-xs text-muted-foreground break-all">
            {{ languages.AGENT_MEDIA_IN_WORKSPACE.replace('{path}', part.path) }}
          </p>
          <TurnWorkflowParameters
            v-else-if="part.kind === 'workflow'"
            :variant="part.variant"
            :settings="part.settings"
            :inputs="part.inputs"
          />
          <template v-else-if="answerOf(part.messageId)">
            <ChatMessageParts
              v-if="item.kind === 'chat'"
              :message="answerOf(part.messageId) as AipgUiMessage"
              section="details"
              :indexes="[part.index]"
              :last="part.messageId === lastChatMessageId"
              :conversation-key="chatKey"
            />
            <AgentMessageParts
              v-else
              :message="answerOf(part.messageId)!"
              section="details"
              :indexes="[part.index]"
            />
          </template>
        </template>
      </TurnDetails>
    </template>
    <template #result>
      <SessionMessage
        v-for="answer in item.kind === 'chat' ? item.answers : []"
        :key="answer.id"
        :message="answer"
        engine="chat"
        unlabelled
        :result-only="resultIndexes(answer.id)"
        footerless
        :last="answer.id === lastChatMessageId"
        :conversation-key="chatKey"
      />
      <template v-for="answer in item.kind === 'agent' ? item.answers : []" :key="answer.id">
        <SessionMessage
          v-if="resultIndexes(answer.id).length > 0"
          :message="answer"
          engine="agent"
          unlabelled
          :result-only="resultIndexes(answer.id)"
        />
      </template>
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
import type { UIMessage } from 'ai'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useI18N } from '@/assets/js/store/i18n'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import type { PendingAudioTurn } from '@/assets/js/store/sessionAudio'
import { useSessions, type PendingMediaTurn } from '@/assets/js/store/sessions'
import AgentMessageParts from '@/components/AgentMessageParts.vue'
import { useTextInference } from '@/assets/js/store/textInference'
import AudioTurnBlock from '@/components/AudioTurnBlock.vue'
import ChatMessageParts from '@/components/ChatMessageParts.vue'
import MediaTurnBlock from '@/components/MediaTurnBlock.vue'
import SessionMessage from '@/components/SessionMessage.vue'
import SessionTurn from '@/components/SessionTurn.vue'
import SessionTurnFooter from '@/components/SessionTurnFooter.vue'
import SessionTurnPrompt from '@/components/SessionTurnPrompt.vue'
import TaskRunBlock from '@/components/TaskRunBlock.vue'
import TurnDetails from '@/components/TurnDetails.vue'
import TurnWorkflowParameters from '@/components/TurnWorkflowParameters.vue'
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
const languages = useI18N().state

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

function answersOf(): UIMessage[] {
  return props.item.kind === 'chat' || props.item.kind === 'agent' ? props.item.answers : []
}

function answerOf(messageId: string): UIMessage | undefined {
  return answersOf().find((answer) => answer.id === messageId)
}

function resultIndexes(messageId: string): number[] {
  if (props.item.kind === 'task-run' || props.item.kind === 'message') return []
  return props.item.result.flatMap((part) =>
    'messageId' in part && part.messageId === messageId ? [part.index] : [],
  )
}

function plainText(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}
</script>
