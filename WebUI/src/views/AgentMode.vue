<template>
  <div class="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6 relative" ref="panel">
    <div class="w-full max-w-4xl mx-auto flex flex-col gap-4 pt-20">
      <!-- Empty state: configuration lives in Agent Settings, model/context in
           the prompt status bar — so an empty transcript just needs a hint. -->
      <div
        v-if="agentMode.messages.length === 0 && !agentMode.processing"
        class="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground"
      >
        <img src="../assets/svg/ai-icon.svg" class="size-10 opacity-60" />
        <p class="text-sm">
          The agent works on files in a workspace folder — it can write code, run shell commands,
          debug web pages and generate media.
        </p>
        <p v-if="agentMode.workspaceDir" class="text-xs break-all">
          Workspace: <span class="text-foreground/80">{{ agentMode.workspaceDir }}</span>
        </p>
        <Button v-else variant="secondary" @click="agentMode.pickWorkspaceFolder()">
          Select a workspace folder…
        </Button>
        <p class="text-xs">
          Configure workspace, model and tools via Agent Settings in the settings sidebar.
        </p>
      </div>

      <!-- Messages -->
      <!-- eslint-disable vue/require-v-for-key -->
      <template v-for="message in agentMode.messages">
        <!-- eslint-enable -->
        <div v-if="message.role === 'user'" class="flex items-start gap-3">
          <UserCircleIcon class="size-6 text-foreground/90" />
          <div class="flex flex-col gap-2 max-w-4/5 bg-muted rounded-md px-4 py-3">
            <MarkdownRenderer :content="messageText(message)" />
          </div>
        </div>
        <div v-else-if="message.role === 'assistant'" class="flex items-start gap-3">
          <img src="../assets/svg/ai-icon.svg" class="size-6" />
          <div class="flex flex-col gap-3 w-full max-w-4/5">
            <template v-for="(part, partIndex) in message.parts" :key="partIndex">
              <MarkdownRenderer v-if="part.type === 'text'" :content="part.text ?? ''" />
              <ChatReasoningDisplay
                v-else-if="part.type === 'reasoning'"
                :text="part.text"
                :streaming="part.state === 'streaming'"
                :startedAt="reasoningTimings[reasoningTimingKey(message.id, partIndex)]?.startedAt"
                :finishedAt="
                  reasoningTimings[reasoningTimingKey(message.id, partIndex)]?.finishedAt
                "
                :liveStartedAt="
                  reasoningTimings[reasoningTimingKey(message.id, partIndex)]?.startedAt
                "
              />
              <div
                v-else-if="asCompaction(part)"
                class="flex flex-col gap-1 rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
              >
                <div class="flex items-center gap-2 font-medium text-foreground/80">
                  <ArchiveBoxArrowDownIcon class="size-4" />
                  <span>
                    Context compacted
                    <span class="text-muted-foreground">({{ asCompaction(part)!.trigger }})</span>
                    <template v-if="compactionDelta(part)"> — {{ compactionDelta(part) }}</template>
                  </span>
                </div>
                <p v-if="asCompaction(part)!.summary" class="whitespace-pre-wrap opacity-80">
                  {{ asCompaction(part)!.summary }}
                </p>
              </div>
              <!-- Media delegation tool: the nested media agent runs in the
                   renderer, so its live steps (mediaAgentRuns, keyed by the
                   bridged toolCallId) and the produced media render inline
                   while the bridged call is still pending. -->
              <div v-else-if="mediaToolName(part)" class="flex flex-col gap-2">
                <ChatToolDisplay
                  :part="asToolPart(part)"
                  :state="asToolPart(part).state"
                  :input="asToolPart(part).input"
                />
                <MediaAgentTimeline
                  :tool-call-id="asToolPart(part).toolCallId"
                  :fallback-steps="mediaToolSteps(part)"
                />
                <ChatWorkflowResult
                  :images="mediaToolImages(part)"
                  :processing="mediaToolProcessing(part)"
                  :stepText="mediaToolStepText(part)"
                />
              </div>
              <div
                v-else-if="isToolUIPart(part as UIMessagePart<UIDataTypes, UITools>)"
                class="flex flex-col gap-1"
              >
                <ChatToolDisplay
                  :part="asToolPart(part)"
                  :state="asToolPart(part).state"
                  :input="asToolPart(part).input"
                />
                <!-- Live output while the tool is still running (Pi streams
                     partial results, e.g. a long-running bash command). -->
                <pre
                  v-if="toolProgressText(part)"
                  class="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
                  >{{ toolProgressText(part) }}</pre
                >
                <!-- What the tool saw: a browser screenshot never reaches the
                     model as pixels, so this is the only place it is visible. -->
                <figure
                  v-for="image in toolImages(part)"
                  :key="image.dataUri"
                  class="flex flex-col gap-1"
                >
                  <img
                    :src="image.dataUri"
                    :alt="`Screenshot: ${image.label}`"
                    class="max-h-96 w-auto self-start rounded-md border border-border"
                  />
                  <figcaption class="text-xs text-muted-foreground">{{ image.label }}</figcaption>
                </figure>
              </div>
            </template>
          </div>
        </div>
      </template>

      <div
        v-if="agentMode.processing"
        class="flex items-center gap-2 text-sm text-muted-foreground"
      >
        <span class="inline-block size-2 rounded-full bg-current animate-pulse"></span>
        <span>{{ busyLabel }}</span>
      </div>
      <div
        v-if="agentMode.chat.error"
        class="rounded border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
      >
        {{ agentMode.chat.error.message }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { isToolUIPart, type UIDataTypes, type UIMessagePart, type UITools } from 'ai'
import type { DynamicToolUIPart, ToolUIPart, UIMessage } from 'ai'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { usePromptStore } from '@/assets/js/store/promptArea'
import type { AipgTools } from '@/assets/js/tools/tools'
import { Button } from '@/components/ui/button'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import ChatToolDisplay from '@/components/ChatToolDisplay.vue'
import ChatReasoningDisplay from '@/components/ChatReasoningDisplay.vue'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import MediaAgentTimeline from '@/components/MediaAgentTimeline.vue'
import type { MediaItem } from '@/assets/js/store/imageGenerationPresets'
import {
  reasoningTimingKey,
  trackReasoningTimings,
  type ReasoningTiming,
} from '@/lib/reasoningTimings'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import { ArchiveBoxArrowDownIcon, UserCircleIcon } from '@heroicons/vue/24/outline'

const agentMode = useAgentMode()
const promptStore = usePromptStore()
const mediaRuns = useMediaAgentRuns()

const panel = ref<HTMLElement | null>(null)

function messageText(message: UIMessage): string {
  return (
    message.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n') ?? ''
  )
}

// Pi's tool parts (tool-bash, tool-read, …) are not part of AipgTools, but the
// generic ChatToolDisplay only reads name/state/input/output — cast for reuse.
function asToolPart(part: unknown): ToolUIPart<AipgTools> | DynamicToolUIPart {
  return part as ToolUIPart<AipgTools> | DynamicToolUIPart
}

/** Tail of a running tool's streamed output kept on screen. */
const MAX_PROGRESS_LINES = 12

/** Arguments long enough to be worth watching arrive (file bodies, patches). */
const STREAMED_ARGUMENT_KEYS = ['content', 'new_string', 'command']

// Two kinds of live text can sit under a tool card, both keyed to a call that
// has not finished: the output Pi streams back over its own IPC channel (merged
// into the store by tool call id), and — before the tool even runs — the
// arguments the model is still dictating, which for a file write is the file.
function toolProgressText(part: unknown): string | undefined {
  const toolPart = asToolPart(part)
  if (toolPart.state !== 'input-available' && toolPart.state !== 'input-streaming') return undefined
  const text = agentMode.toolProgress[toolPart.toolCallId] ?? streamedArgument(toolPart.input)
  if (!text) return undefined
  return text.split('\n').slice(-MAX_PROGRESS_LINES).join('\n')
}

function toolImages(part: unknown): AgentToolImage[] {
  return agentMode.toolImages[asToolPart(part).toolCallId] ?? []
}

function streamedArgument(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) return undefined
  const record = input as Record<string, unknown>
  const key = STREAMED_ARGUMENT_KEYS.find((candidate) => typeof record[candidate] === 'string')
  return key ? (record[key] as string) : undefined
}

// Pi's context compaction surfaces as a dynamic-tool part named 'compaction'
// (the stream translator turns the compaction events into a synthetic tool
// call+result whose output carries the trigger/summary/token counts). Render it
// as a notice instead of a generic tool card.
type CompactionOutput = {
  trigger: 'manual' | 'threshold' | 'overflow'
  summary: string
  tokensBefore?: number
  tokensAfter?: number
}

function asCompaction(part: unknown): CompactionOutput | null {
  const p = part as { type?: string; toolName?: string; output?: unknown }
  if (p?.type !== 'dynamic-tool' || p.toolName !== 'compaction') return null
  const output = p.output as CompactionOutput | undefined
  return output && typeof output === 'object' ? output : null
}

// The bridged `media` delegation tool (and the legacy generateImage/editImage
// bridged tools). Handles both part encodings: `tool-media` and dynamic-tool
// named 'media'.
const MEDIA_BRIDGE_TOOL_NAMES = new Set(['media', 'generateImage', 'editImage'])

type MediaToolPart = {
  type?: string
  toolName?: string
  state?: string
  output?: { images?: unknown; steps?: unknown }
}

function mediaToolName(part: unknown): string | undefined {
  const p = part as MediaToolPart
  const toolName =
    p?.type === 'dynamic-tool'
      ? p.toolName
      : typeof p?.type === 'string' && p.type.startsWith('tool-')
        ? p.type.slice('tool-'.length)
        : undefined
  return toolName && MEDIA_BRIDGE_TOOL_NAMES.has(toolName) ? toolName : undefined
}

/** Step lines from a finished result, for runs no longer in the store. */
function mediaToolSteps(part: unknown): string[] | undefined {
  const steps = (part as MediaToolPart).output?.steps
  return Array.isArray(steps) ? (steps as string[]) : undefined
}

function mediaRun(part: unknown) {
  return mediaRuns.run(asToolPart(part).toolCallId)
}

/** Finished media from the tool output, or what the live run has so far. */
function mediaToolImages(part: unknown): MediaItem[] {
  const completed = mediaToolItems(part)
  if (completed.length) return completed
  return mediaRun(part)?.steps.flatMap((step) => step.media) ?? []
}

function mediaToolProcessing(part: unknown): boolean {
  return mediaRun(part)?.state === 'running'
}

function mediaToolStepText(part: unknown): string | undefined {
  return mediaRun(part)?.steps.findLast((step) => step.state === 'running')?.label
}

/**
 * Completed tool parts whose output carries a comfy-shaped `images` array,
 * synthesized into full MediaItems so ChatWorkflowResult renders images,
 * videos and 3D models alike.
 */
function mediaToolItems(part: unknown): MediaItem[] {
  const p = part as MediaToolPart
  if (!mediaToolName(part) || p.state !== 'output-available') return []
  const images = p.output?.images
  if (!Array.isArray(images)) return []
  return images
    .filter((item): item is Record<string, unknown> => typeof item === 'object' && item !== null)
    .map(
      (item) =>
        ({
          mode: 'imageGen',
          settings: {},
          ...item,
          state: 'done',
        }) as MediaItem,
    )
    .filter((item) => {
      if (item.type === 'image') return !!item.imageUrl
      if (item.type === 'video') return !!item.videoUrl
      if (item.type === 'model3d') return !!item.model3dUrl
      return false
    })
}

// Pi's post-compaction size is an estimate it cannot always produce, so fall
// back to reporting just how much was summarized.
function compactionDelta(part: unknown): string {
  const output = asCompaction(part)
  if (!output || output.tokensBefore === undefined) return ''
  const before = output.tokensBefore.toLocaleString()
  if (output.tokensAfter === undefined) return `${before} tokens summarized`
  return `${before} → ${output.tokensAfter.toLocaleString()} tokens`
}

// ── Live reasoning timing ────────────────────────────────────────────────────
//
// Reasoning UI parts carry a `state` ('streaming' | 'done') but no wall-clock
// timing, so ChatReasoningDisplay's timer needs a start (and end) supplied by
// the host. `trackReasoningTimings` records them per part, so each block shows a
// live-advancing then final duration.
const reasoningTimings = reactive<Record<string, ReasoningTiming>>({})

watch(
  // Lightweight signal: only the last assistant message's part types + states,
  // so a deep watch over growing (and large) message content is avoided.
  () => {
    const last = agentMode.messages.at(-1)
    if (!last || last.role !== 'assistant') return ''
    return (last.parts ?? [])
      .map((p, pi) => `${last.id}:${pi}:${p.type}:${'state' in p ? p.state : ''}`)
      .join('|')
  },
  () => {
    const last = agentMode.messages.at(-1)
    if (!last || last.role !== 'assistant') return
    trackReasoningTimings(reasoningTimings, last, { live: agentMode.processing })
  },
  // Immediate, so a view mounted mid-turn (switching modes and back) still times
  // the block that is already streaming.
  { immediate: true },
)

// ── Descriptive busy label ───────────────────────────────────────────────────
//
// Derive "what the agent is doing right now" from the last in-flight part,
// instead of a generic "Agent is working…". A finished tool (output-available)
// means the model is deciding its next step → "Thinking…".
function truncate(value: unknown, max = 48): string {
  if (typeof value !== 'string') return ''
  return value.length > max ? `${value.slice(0, max)}…` : value
}

function toolActionLabel(name: string, input: Record<string, unknown> | undefined): string {
  const filePath = truncate(input?.file_path)
  switch (name) {
    case 'read':
      return `Reading ${filePath}…`
    case 'edit':
      return `Editing ${filePath}…`
    case 'write':
      return `Writing ${filePath}…`
    case 'ls':
      return 'Listing files…'
    case 'bash':
      return `Running: ${truncate(input?.command)}`
    case 'navigate_page':
      return input?.url ? `Opening ${truncate(input.url)}…` : 'Navigating…'
    case 'list_console_messages':
      return 'Reading browser console…'
    case 'list_pages':
      return 'Listing browser pages…'
    case 'take_screenshot':
      return 'Taking screenshot…'
    case 'take_snapshot':
      return 'Snapshotting page…'
    case 'evaluate_script':
      return 'Running script in page…'
    case 'generateImage':
      return 'Generating image…'
    case 'editImage':
      return 'Editing image…'
    case 'media':
      return 'Creating media…'
    default:
      return `Running ${name}…`
  }
}

const busyLabel = computed<string>(() => {
  const parts = agentMode.messages.at(-1)?.parts ?? []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastPart = parts.at(-1) as any
  if (!lastPart) return 'Agent is working…'
  if (lastPart.type === 'reasoning' && lastPart.state !== 'done') return 'Thinking…'
  if (lastPart.type === 'text' && lastPart.state === 'streaming') return 'Writing response…'
  const toolName: string | undefined =
    lastPart.type === 'dynamic-tool'
      ? lastPart.toolName
      : typeof lastPart.type === 'string' && lastPart.type.startsWith('tool-')
        ? lastPart.type.slice('tool-'.length)
        : undefined
  if (toolName) {
    if (lastPart.state === 'input-streaming' || lastPart.state === 'input-available') {
      // A delegated media call knows more than its own name: say which step of
      // the nested run is in flight instead of a generic "Creating media…".
      return mediaToolStepText(lastPart) ?? toolActionLabel(toolName, lastPart.input)
    }
    // Tool finished — the model is generating its next move.
    return 'Thinking…'
  }
  return 'Agent is working…'
})

function handlePromptSubmit(prompt: string) {
  void agentMode.generate(prompt)
}

function handleCancel() {
  void agentMode.stop()
}

watch(
  () => agentMode.messages.length + (agentMode.messages.at(-1)?.parts?.length ?? 0),
  async () => {
    await nextTick()
    panel.value?.scrollTo({ top: panel.value.scrollHeight })
  },
)

onMounted(() => {
  promptStore.registerSubmitCallback('agent', handlePromptSubmit)
  promptStore.registerCancelCallback('agent', handleCancel)
})

onUnmounted(() => {
  promptStore.unregisterSubmitCallback('agent')
  promptStore.unregisterCancelCallback('agent')
})
</script>
