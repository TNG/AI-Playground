<template>
  <MarkdownRenderer
    v-if="part.type === 'text'"
    role="region"
    :aria-label="languages.AGENT_REPLY_ARIA"
    :content="answerText"
    :on-file-open="openCreatedFile"
  />
  <ChatReasoningDisplay
    v-else-if="part.type === 'reasoning'"
    :text="part.text"
    :streaming="part.state === 'streaming' && !reasoningTiming.finishedAt"
    :startedAt="reasoningTiming.startedAt"
    :finishedAt="reasoningTiming.finishedAt"
  />
  <div
    v-else-if="compaction"
    class="flex flex-col gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
  >
    <div class="flex items-center gap-2 font-medium text-foreground/80">
      <ArchiveBoxArrowDownIcon class="size-4" />
      <span>
        Context compacted
        <span class="text-muted-foreground">({{ compaction.trigger }})</span>
        <template v-if="compactionDelta"> — {{ compactionDelta }}</template>
      </span>
    </div>
    <p v-if="compaction.summary" class="whitespace-pre-wrap opacity-80">{{ compaction.summary }}</p>
  </div>
  <!-- Media delegation tool: the nested specialist runs in main; live steps
       reach mediaAgentRuns via kernel events (keyed by toolCallId). -->
  <div v-else-if="mediaToolNameOf(part)" class="flex flex-col gap-2">
    <template v-if="section !== 'result'">
      <ChatToolDisplay :part="toolPart" :state="toolPart.state" :input="toolPart.input" />
      <MediaAgentTimeline :tool-call-id="toolPart.toolCallId" :fallback-steps="mediaToolSteps" />
    </template>
    <template v-if="section !== 'details'">
      <ChatWorkflowResult v-if="!hideMediaGrid" :artifacts="gridArtifacts ?? mediaToolArtifacts" />
      <TurnFailureLine v-if="mediaToolFailure" :failure="mediaToolFailure" />
    </template>
  </div>
  <div v-else-if="audioArtifacts.length > 0" class="flex flex-col gap-2">
    <ChatToolDisplay
      v-if="section !== 'result'"
      :part="toolPart"
      :state="toolPart.state"
      :input="toolPart.input"
    />
    <template v-if="section !== 'details'">
      <AudioArtifactCard
        v-for="artifact in audioArtifacts"
        :key="artifact.id"
        :artifact="artifact"
      />
    </template>
  </div>
  <div v-else-if="isToolUIPart(part)" class="flex flex-col gap-1">
    <ChatToolDisplay
      v-if="section !== 'result'"
      :part="toolPart"
      :state="toolPart.state"
      :input="toolPart.input"
    />
    <!-- Live output while the tool is still running (Pi streams partial results,
         e.g. a long-running bash command). -->
    <pre
      v-if="toolProgressText"
      class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
      >{{ toolProgressText }}</pre>
    <!-- The screenshot never reaches the model as pixels, so this is where it is shown. -->
    <ChatWorkflowResult
      v-if="section !== 'details' && screenshotArtifacts.length > 0"
      :artifacts="screenshotArtifacts"
    />
    <figure v-for="image in bareToolImages" :key="image.dataUri" class="flex flex-col gap-1">
      <LetterboxImage :src="image.dataUri" :alt="`Screenshot: ${image.label}`" />
      <figcaption class="text-xs text-muted-foreground">{{ image.label }}</figcaption>
    </figure>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { isToolUIPart, type UIDataTypes, type UIMessagePart, type UITools } from 'ai'
import type { DynamicToolUIPart, ToolUIPart } from 'ai'
import { createAppError } from '@/assets/js/errors/appError'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useSessions } from '@/assets/js/store/sessions'
import type { AipgTools } from '@/assets/js/tools/tools'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import ChatToolDisplay from '@/components/ChatToolDisplay.vue'
import ChatReasoningDisplay from '@/components/ChatReasoningDisplay.vue'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import AudioArtifactCard from '@/components/AudioArtifactCard.vue'
import LetterboxImage from '@/components/LetterboxImage.vue'
import TurnFailureLine from '@/components/TurnFailureLine.vue'
import MediaAgentTimeline from '@/components/MediaAgentTimeline.vue'
import { linkifyAnswerFiles } from '@/lib/answerFileLinks'
import { compactionOutputOf, generatedMediaOf, mediaToolNameOf } from '@/lib/agentTranscript'
import { ttsToolArtifacts } from '@/lib/audioArtifacts'
import {
  toolCallArtifacts,
  screenshotToolArtifacts,
  toolCallResultFailure,
  type TurnArtifact,
} from '@/lib/turnArtifacts'
import { reasoningTimingOf } from '@/lib/reasoningTimings'
import { ArchiveBoxArrowDownIcon } from '@heroicons/vue/24/outline'

// One part of an assistant message in Agent Mode: text, a reasoning block, a
// compaction notice, or a tool call — with whatever the call produced under it
// (streamed output, web screenshots, generated media).

const props = defineProps<{
  part: UIMessagePart<UIDataTypes, UITools>
  section?: 'details' | 'result'
  /** Consecutive media parts share one grid: merged artifacts for the run's first part. */
  gridArtifacts?: TurnArtifact[]
  /** Consecutive media parts share one grid: non-first parts render no grid of their own. */
  hideMediaGrid?: boolean
  /** The files this message's writing tools created, for linkifying its text mentions. */
  createdFiles?: readonly string[]
}>()

const errors = useErrors()
const languages = useI18N().state
const agentMode = useAgentMode()
const mediaRuns = useMediaAgentRuns()
const artifactRuns = useArtifactRuns()
const sessions = useSessions()

const answerText = computed(() => {
  if (props.part.type !== 'text') return ''
  const text = (props.part as { text?: string }).text ?? ''
  const files = props.createdFiles ?? []
  return files.length > 0
    ? linkifyAnswerFiles(text, files, languages.ANSWER_FILE_OPEN_TOOLTIP)
    : text
})

async function openCreatedFile(filePath: string) {
  const sessionId = agentMode.openSessionId
  if (!sessionId) return
  const result = await window.electronAPI.agentMode.sessionFileAction(sessionId, filePath, 'open')
  if (result.success) return
  errors.report(
    createAppError({
      category: 'file',
      code: 'answer/file-open-failed',
      userMessage: result.error ?? '',
      technicalMessage: `sessionFileAction failed for ${filePath}`,
      surface: 'toast',
      context: { sessionId, filePath },
    }),
  )
}

// Pi's tool parts (tool-bash, tool-read, …) are not part of AipgTools, but the
// generic ChatToolDisplay only reads name/state/input/output — cast for reuse.
const toolPart = computed(() => props.part as unknown as ToolUIPart<AipgTools> | DynamicToolUIPart)

/** Tail of a running tool's streamed output kept on screen. */
const MAX_PROGRESS_LINES = 12

/** Arguments long enough to be worth watching arrive (file bodies, patches). */
const STREAMED_ARGUMENT_KEYS = ['content', 'new_string', 'command']

// Two kinds of live text can sit under a tool card, both keyed to a call that
// has not finished: the output Pi streams back over its own IPC channel (merged
// into the store by tool call id), and — before the tool even runs — the
// arguments the model is still dictating, which for a file write is the file.
const toolProgressText = computed<string | undefined>(() => {
  const tool = toolPart.value
  if (tool.state !== 'input-available' && tool.state !== 'input-streaming') return undefined
  const text = agentMode.toolProgress[tool.toolCallId] ?? streamedArgument(tool.input)
  if (!text) return undefined
  return text.split('\n').slice(-MAX_PROGRESS_LINES).join('\n')
})

function streamedArgument(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  const key = STREAMED_ARGUMENT_KEYS.find((candidate) => typeof record[candidate] === 'string')
  return key ? (record[key] as string) : undefined
}

const toolImages = computed<AgentToolImage[]>(
  () => agentMode.toolImages[toolPart.value.toolCallId] ?? [],
)

const screenshotArtifacts = computed(() =>
  screenshotToolArtifacts(props.part, sessions.openDeletedFiles),
)

const bareToolImages = computed(() =>
  screenshotArtifacts.value.length > 0 ? [] : toolImages.value,
)

const compaction = computed(() => compactionOutputOf(props.part))
const reasoningTiming = computed(() => reasoningTimingOf(props.part))

// Pi's post-compaction size is an estimate it cannot always produce, so fall
// back to reporting just how much was summarized.
const compactionDelta = computed<string>(() => {
  const output = compaction.value
  if (!output || output.tokensBefore === undefined) return ''
  const before = output.tokensBefore.toLocaleString()
  if (output.tokensAfter === undefined) return `${before} tokens summarized`
  return `${before} → ${output.tokensAfter.toLocaleString()} tokens`
})

const generatedMedia = computed(() => generatedMediaOf(props.part))

/** Step lines from a finished result, for runs no longer in the store. */
const mediaToolSteps = computed(() => generatedMedia.value?.steps)

const mediaToolArtifacts = computed(() =>
  toolCallArtifacts(props.part, artifactRuns.state, sessions.openDeletedFiles),
)

const mediaToolFailure = computed(() => toolCallResultFailure(props.part))

const audioArtifacts = computed(() => ttsToolArtifacts(props.part, sessions.openDeletedFiles))

watch(
  [
    () => mediaToolNameOf(props.part),
    () => toolPart.value.toolCallId,
    () => toolPart.value.state,
  ] as const,
  ([isMedia, id, state]) => {
    if (!isMedia || props.section === 'details') return
    if (state === 'output-available' && toolPart.value.output != null) {
      mediaRuns.endRun(id, 'done')
    }
    if (state === 'output-error') mediaRuns.endRun(id, 'failed')
  },
)
</script>
