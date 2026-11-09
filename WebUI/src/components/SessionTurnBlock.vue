<template>
  <div
    v-if="item.kind === 'message'"
    class="mx-auto w-full max-w-3xl text-sm text-muted-foreground whitespace-pre-wrap"
    :class="{ 'text-right': item.message.role === 'user' }"
  >
    {{ plainText(item.message) }}
  </div>
  <SessionTurn v-else>
    <template v-if="item.prompt" #prompt>
      <SessionTurnPrompt
        :prompt="item.prompt"
        :queued="item.kind === 'agent' && item.queued"
        :not-run="item.kind === 'agent' && item.notRun"
        :can-resend="item.kind === 'agent' && item.canResend"
        :controls="runControls"
        @resend="emit('resend')"
        @stop="runControls && agentTasks.stopTask(runControls.agentId)"
        @edit-agent="runControls && manageAgents(runControls.agentId)"
      />
    </template>
    <template #details>
      <TurnDetails :details="item.details" :hint="item.hint">
        <template v-if="question || heldAnswer" #status>
          <ChatConfirmation v-if="question" :conversation-key="question" />
          <TurnHeldAnswer
            v-if="heldAnswer && item.kind === 'agent'"
            :channel="heldAnswer.channel"
            @discard="agentMode.discardHeldAnswer(item.harnessSessionId)"
          />
        </template>
        <template v-for="(part, index) in item.details.parts" :key="index">
          <p v-if="part.kind === 'workspace-path'" class="text-xs text-muted-foreground break-all">
            {{ fillTemplate(languages.AGENT_MEDIA_IN_WORKSPACE, { path: part.path }) }}
          </p>
          <div
            v-else-if="part.kind === 'step-prompt'"
            role="group"
            :aria-label="
              fillTemplate(languages.AGENT_TASK_STEP_LABEL, { number: String(part.step) })
            "
            class="flex flex-col gap-1 rounded-md bg-muted px-3 py-2 text-sm"
          >
            <p class="text-xs text-muted-foreground">
              {{ fillTemplate(languages.AGENT_TASK_STEP_LABEL, { number: String(part.step) }) }}
            </p>
            <MarkdownRenderer :content="part.prompt.text" />
          </div>
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
      <template v-for="answer in item.kind === 'chat' ? item.answers : []" :key="answer.id">
        <SessionMessage
          v-if="resultIndexes(answer.id).length > 0"
          :message="answer"
          engine="chat"
          unlabelled
          :result-only="resultIndexes(answer.id)"
          footerless
          :last="answer.id === lastChatMessageId"
          :conversation-key="chatKey"
        />
      </template>
      <SessionAssistantBubble v-if="item.kind === 'chat' && turnFailure">
        <TurnFailureLine :failure="turnFailure" />
      </SessionAssistantBubble>
      <template v-for="answer in item.kind === 'agent' ? item.answers : []" :key="answer.id">
        <SessionMessage
          v-if="resultIndexes(answer.id).length > 0"
          :message="answer"
          engine="agent"
          unlabelled
          :result-only="resultIndexes(answer.id)"
        />
      </template>
      <SessionAssistantBubble v-if="item.kind === 'agent' && turnFailure">
        <TurnFailureLine :failure="turnFailure" />
      </SessionAssistantBubble>
      <MediaTurnBlock
        v-if="item.kind === 'media' || item.kind === 'pending-media'"
        :artifacts="item.artifacts"
        :failure="mediaFailure"
      />
      <AudioTurnBlock
        v-else-if="item.kind === 'audio'"
        :kind="item.audio.kind"
        :artifacts="item.audioArtifacts"
        :transcript="item.audio.transcript"
        :status="item.audio.status"
        :error="item.audio.error"
      />
      <AudioTurnBlock
        v-else-if="item.kind === 'pending-audio'"
        :kind="item.pending.kind"
        :artifacts="item.audioArtifacts"
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
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useConfirmations } from '@/assets/js/store/confirmations'
import { useI18N } from '@/assets/js/store/i18n'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import type { PendingAudioTurn } from '@/assets/js/store/sessionAudio'
import type { PendingMediaTurn } from '@/assets/js/store/sessions'
import AgentMessageParts from '@/components/AgentMessageParts.vue'
import { useTextInference } from '@/assets/js/store/textInference'
import AudioTurnBlock from '@/components/AudioTurnBlock.vue'
import ChatConfirmation from '@/components/ChatConfirmation.vue'
import ChatMessageParts from '@/components/ChatMessageParts.vue'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import MediaTurnBlock from '@/components/MediaTurnBlock.vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import SessionMessage from '@/components/SessionMessage.vue'
import SessionTurn from '@/components/SessionTurn.vue'
import SessionTurnFooter from '@/components/SessionTurnFooter.vue'
import SessionTurnPrompt from '@/components/SessionTurnPrompt.vue'
import TurnDetails from '@/components/TurnDetails.vue'
import TurnFailureLine from '@/components/TurnFailureLine.vue'
import TurnHeldAnswer from '@/components/TurnHeldAnswer.vue'
import TurnWorkflowParameters from '@/components/TurnWorkflowParameters.vue'
import { fillTemplate } from '@/lib/fillTemplate'
import { agentRunControls } from '@/lib/sessionTimeline'
import { useAgentLibraryEntry } from '@/lib/useAgentLibraryEntry'
import type { SessionTimelineItem, TurnFailurePart } from '@/lib/turnTypes'
import type { TimelineMessage } from '@/types/sessionTimeline'

const props = defineProps<{
  item: SessionTimelineItem<PendingMediaTurn, PendingAudioTurn>
  lastChatMessageId?: string
  chatKey: string
}>()

const emit = defineEmits<{ resend: [] }>()

const textInference = useTextInference()
const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const { manageAgents } = useAgentLibraryEntry()
const confirmations = useConfirmations()
const languages = useI18N().state

// A deleted Agent has nothing left to edit; it cannot be running either.
const runControls = computed(() => {
  const controls = agentRunControls(props.item)
  return controls && agentTasks.tasks.some((task) => task.id === controls.agentId) ? controls : null
})

const footerShown = computed(() => {
  if (props.item.kind === 'message') return false
  const footer = props.item.footer
  return footer.actions.length > 0 || (textInference.metricsEnabled && !!footer.metrics)
})

const question = computed(() => {
  const key =
    props.item.kind === 'chat' || props.item.kind === 'agent' ? props.item.questionKey : undefined
  return key && confirmations.forConversation(key) ? key : undefined
})

const heldAnswer = computed(() => (props.item.kind === 'agent' ? props.item.heldAnswer : undefined))

function answersOf(): UIMessage[] {
  return props.item.kind === 'chat' || props.item.kind === 'agent' ? props.item.answers : []
}

function answerOf(messageId: string): UIMessage | undefined {
  return answersOf().find((answer) => answer.id === messageId)
}

function resultIndexes(messageId: string): number[] {
  if (props.item.kind === 'message') return []
  return props.item.result.flatMap((part) =>
    'messageId' in part && part.messageId === messageId && part.index !== undefined
      ? [part.index]
      : [],
  )
}

const mediaFailure = computed(() => {
  if (props.item.kind !== 'media' && props.item.kind !== 'pending-media') return undefined
  return props.item.result.find((part): part is TurnFailurePart => part.kind === 'failure')
})

const turnFailure = computed(() => {
  if (props.item.kind !== 'chat' && props.item.kind !== 'agent') return undefined
  return props.item.result.find(
    (part): part is TurnFailurePart => part.kind === 'failure' && part.messageId === undefined,
  )
})

function plainText(message: TimelineMessage): string {
  return message.parts.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n')
}
</script>
