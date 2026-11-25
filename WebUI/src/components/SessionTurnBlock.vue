<template>
  <div
    v-if="item.kind === 'message'"
    class="w-full text-sm text-muted-foreground whitespace-pre-wrap"
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
        :editing="editing"
        :submitting="turnBusy"
        @resend="emit('resend')"
        @edit-agent="runControls && manageAgents(runControls.agentId)"
        @cancel-edit="editing = false"
        @edit-prompt="submitEdit"
      />
    </template>
    <template #details>
      <TurnDetails :details="item.details" :hint="item.hint">
        <template v-if="question" #status>
          <ChatConfirmation :conversation-key="question" />
        </template>
        <template v-for="(part, index) in item.details.parts" :key="index">
          <p v-if="part.kind === 'workspace-path'" class="text-xs text-muted-foreground break-all">
            {{ fillTemplate(languages.AGENT_MEDIA_IN_WORKSPACE, { path: part.path }) }}
          </p>
          <TurnWorkflowParameters
            v-else-if="part.kind === 'workflow'"
            :variant="part.variant"
            :settings="part.settings"
            :inputs="part.inputs"
          />
          <TurnOverviewUpdate
            v-else-if="part.kind === 'overview-update'"
            :entry-id="part.entryId"
            :update="part.update"
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
      <!-- Every file the turn wrote is reachable here even when no answer names it. -->
      <div v-if="turnFiles.length > 0" class="flex items-start gap-3">
        <span :class="textInference.iconSizeClass" class="shrink-0" aria-hidden="true" />
        <div class="flex min-w-0 max-w-[90%] flex-1 flex-col gap-1">
          <p class="text-muted-foreground" :class="textInference.nameSizeClass">
            {{ languages.ANSWER_CREATED_FILES }}
          </p>
          <div class="flex flex-wrap items-center gap-1">
            <FileChip
              v-for="file in turnFiles"
              :key="file"
              :file="file"
              :deleted="fileMissing(file)"
              :aria-pressed="openFile === file"
              @toggle="toggleFilePreview"
            />
          </div>
          <FilePreview
            v-if="openFile"
            :key="openFile"
            :file="openFile"
            :session-id="harnessSessionIdOf()"
            @missing="markOpenFile(true)"
            @present="markOpenFile(false)"
            @deleted="onPreviewDeleted"
          />
        </div>
      </div>
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
      <SessionTurnFooter :footer="item.footer" @edit="editing = true" />
    </template>
  </SessionTurn>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { UIMessage } from 'ai'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useConfirmations } from '@/assets/js/store/confirmations'
import { useI18N } from '@/assets/js/store/i18n'
import { useSessionFiles, missingFileKey } from '@/assets/js/store/sessionFiles'
import type { AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import type { PendingAudioTurn } from '@/assets/js/store/sessionAudio'
import type { PendingMediaTurn } from '@/assets/js/store/sessions'
import { noFooter } from '@/lib/turnFooter'
import { useTurnActions } from '@/lib/useTurnActions'
import { createdFilesOfMessages } from '@/lib/answerFileLinks'
import AgentMessageParts from '@/components/AgentMessageParts.vue'
import FileChip from '@/components/FileChip.vue'
import FilePreview from '@/components/FilePreview.vue'
import { useTextInference } from '@/assets/js/store/textInference'
import AudioTurnBlock from '@/components/AudioTurnBlock.vue'
import ChatConfirmation from '@/components/ChatConfirmation.vue'
import ChatMessageParts from '@/components/ChatMessageParts.vue'
import MediaTurnBlock from '@/components/MediaTurnBlock.vue'
import SessionAssistantBubble from '@/components/SessionAssistantBubble.vue'
import SessionMessage from '@/components/SessionMessage.vue'
import SessionTurn from '@/components/SessionTurn.vue'
import SessionTurnFooter from '@/components/SessionTurnFooter.vue'
import SessionTurnPrompt from '@/components/SessionTurnPrompt.vue'
import TurnDetails from '@/components/TurnDetails.vue'
import TurnFailureLine from '@/components/TurnFailureLine.vue'
import TurnOverviewUpdate from '@/components/TurnOverviewUpdate.vue'
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
const agentTasks = useAgentTasks()
const { manageAgents } = useAgentLibraryEntry()
const confirmations = useConfirmations()
const sessionFiles = useSessionFiles()
const languages = useI18N().state

const editing = ref(false)

const turnActions = useTurnActions(() =>
  props.item.kind === 'message' ? noFooter() : props.item.footer,
)
const turnBusy = computed(() => props.item.kind !== 'message' && turnActions.busy.value)

async function submitEdit(text: string): Promise<void> {
  editing.value = false
  if (props.item.kind === 'message') return
  await turnActions.regenerate({ text, promptMessageId: props.item.id })
}

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

function answersOf(): UIMessage[] {
  return props.item.kind === 'chat' || props.item.kind === 'agent' ? props.item.answers : []
}

// A chip names the harness session that produced its message, which is not
// necessarily the one the agentMode store holds open.
function harnessSessionIdOf(): string | undefined {
  return props.item.kind === 'agent' ? props.item.harnessSessionId : undefined
}

// A turn's files cover every answer, so the Result's chip row stays complete
// however the model phrased things.
const turnCreatedFiles = computed(() =>
  props.item.kind === 'agent' ? createdFilesOfMessages(props.item.answers) : undefined,
)
const turnFiles = computed(() => turnCreatedFiles.value ?? [])

// One preview at a time: tapping the open chip again closes it.
const openFile = ref<string | null>(null)
function toggleFilePreview(file: string): void {
  openFile.value = openFile.value === file ? null : file
}

// A chip crosses out its file once a listing or the preview's own read says the
// file is gone from disk; a read that succeeds crosses it back in.
function fileMissing(file: string): boolean {
  const harnessSessionId = harnessSessionIdOf()
  return (
    !!harnessSessionId && sessionFiles.missingFileKeys.has(missingFileKey(harnessSessionId, file))
  )
}

function markOpenFile(missing: boolean): void {
  const harnessSessionId = harnessSessionIdOf()
  const file = openFile.value
  if (!harnessSessionId || !file) return
  if (missing) sessionFiles.markMissing(harnessSessionId, file)
  else sessionFiles.markPresent(harnessSessionId, file)
}

// A delete from the chat strikes the chip at once and reconciles the listing,
// so an open Artifacts tab drops the card without waiting for its own trigger.
function onPreviewDeleted(): void {
  markOpenFile(true)
  void sessionFiles.refresh()
}

// A file a streaming turn just wrote is on disk again, so a same-named rewrite
// of a deleted file must not keep (or pick up) the struck-out chip. Only files
// newly appearing while the turn streams count: a settled turn's parts say
// nothing about the file's existence now. `immediate` covers a remount
// mid-turn, whose files this very turn wrote.
watch(
  turnFiles,
  (files, previous) => {
    if (props.item.kind !== 'agent' || !props.item.streaming) return
    const harnessSessionId = harnessSessionIdOf()
    if (!harnessSessionId) return
    const seen = new Set(previous ?? [])
    for (const file of files) {
      if (!seen.has(file)) sessionFiles.markPresent(harnessSessionId, file)
    }
  },
  { immediate: true },
)

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
