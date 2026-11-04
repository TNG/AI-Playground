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
    <template #prompt>
      <SessionMessage
        v-if="item.kind === 'chat' && item.prompt"
        :message="item.prompt"
        engine="chat"
        :last="item.prompt.id === lastChatMessageId"
        :conversation-key="chatKey"
      />
      <SessionMessage
        v-else-if="item.kind === 'agent' && item.prompt"
        :message="item.prompt"
        engine="agent"
        :queued="item.queued"
        :not-run="item.notRun"
        :can-resend="item.canResend"
        @resend="emit('resend')"
      />
      <SessionUserBubble v-else-if="item.kind === 'media' || item.kind === 'pending-media'">
        <p v-if="mediaPrompt" class="whitespace-pre-wrap">{{ mediaPrompt }}</p>
        <p v-else class="text-muted-foreground italic">{{ item.hint.preset }}</p>
      </SessionUserBubble>
      <SessionUserBubble v-else-if="item.kind === 'audio' || item.kind === 'pending-audio'">
        <p class="whitespace-pre-wrap">{{ audioPrompt || item.hint.preset }}</p>
        <template v-if="item.kind === 'audio' && item.audio.kind === 'stt'">
          <p v-if="audioFileDeleted" class="text-sm text-muted-foreground">
            {{ languages.SESSION_FILE_DELETED }}
          </p>
          <audio
            v-else-if="item.audio.audioUrl"
            controls
            class="w-full max-w-md"
            :src="item.audio.audioUrl"
            :aria-label="item.prompt"
          />
        </template>
      </SessionUserBubble>
    </template>
    <template #result>
      <SessionMessage
        v-for="answer in item.kind === 'chat' ? item.answers : []"
        :key="answer.id"
        :message="answer"
        engine="chat"
        unlabelled
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
        :mode="item.media.mode"
        :items="item.media.items"
        :status="item.media.status"
        :error="item.media.error"
        :deleted-urls="sessions.openDeletedFiles"
        @delete-file="(url) => gallery.removeByUrl(url)"
      />
      <MediaTurnBlock
        v-else-if="item.kind === 'pending-media'"
        :mode="item.pending.mode"
        :items="artifactRuns.state.runs[item.pending.runId]?.items ?? []"
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
  </SessionTurn>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useGallery } from '@/assets/js/store/gallery'
import { useI18N } from '@/assets/js/store/i18n'
import type { PendingAudioTurn } from '@/assets/js/store/sessionAudio'
import { useSessions, type PendingMediaTurn } from '@/assets/js/store/sessions'
import AudioTurnBlock from '@/components/AudioTurnBlock.vue'
import MediaTurnBlock from '@/components/MediaTurnBlock.vue'
import SessionMessage from '@/components/SessionMessage.vue'
import SessionTurn from '@/components/SessionTurn.vue'
import SessionUserBubble from '@/components/SessionUserBubble.vue'
import TaskRunBlock from '@/components/TaskRunBlock.vue'
import type { SessionTimelineItem } from '@/lib/sessionTimeline'
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
const gallery = useGallery()
const artifactRuns = useArtifactRuns()
const languages = useI18N().state

const mediaPrompt = computed(() => {
  if (props.item.kind === 'media') return props.item.prompt
  if (props.item.kind === 'pending-media') return props.item.pending.prompt
  return ''
})

const audioPrompt = computed(() => {
  if (props.item.kind === 'audio') return props.item.prompt
  if (props.item.kind === 'pending-audio') return props.item.pending.prompt
  return ''
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
