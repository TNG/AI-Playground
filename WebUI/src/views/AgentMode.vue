<template>
  <div class="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6 relative" ref="panel">
    <div class="w-full max-w-4xl mx-auto flex flex-col gap-4">
      <!-- Game Agent works on one game at a time, and what to do with that game
           (play it, save it to the library, open its folder) belongs next to it —
           and stays reachable once the transcript has scrolled past it. Pinned to
           the top, it shares that line with the floating "Show Sessions" button
           (App.vue), so it takes only the width it needs and keeps to the right. -->
      <div v-if="isGameAgent" class="sticky top-0 z-5 flex justify-end pl-32 pr-32">
        <GameBar />
      </div>

      <!-- Empty state: configuration lives in Agent Settings, model/context in
           the prompt status bar — so an empty transcript just needs a hint. -->
      <div
        v-if="agentMode.messages.length === 0 && !agentMode.processing"
        class="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground"
      >
        <img src="../assets/svg/ai-icon.svg" class="size-10 opacity-60" />
        <template v-if="isGameAgent">
          <p class="text-sm">
            Describe the game you want — the agent writes it as a single HTML page, draws the art,
            play-tests it in a browser and saves it to your library.
          </p>
          <p class="text-xs">Try: “a one-button endless runner where I dodge asteroids”.</p>
        </template>
        <template v-else>
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
        </template>
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
            <template v-for="segment in segmentsOf(message)" :key="segment.key">
              <AgentMessagePart v-if="segment.kind === 'part'" :part="asPart(segment.part)" />
              <!-- A finished stretch of thinking and tool calls, folded away so
                   the answer and the media it produced stay in view. -->
              <AgentActivitySummary v-else :summary="segment.summary">
                <AgentMessagePart
                  v-for="(part, index) in segment.parts"
                  :key="index"
                  :part="asPart(part)"
                />
              </AgentActivitySummary>
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
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { UIDataTypes, UIMessagePart, UITools, UIMessage } from 'ai'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { Button } from '@/components/ui/button'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import AgentMessagePart from '@/components/AgentMessagePart.vue'
import AgentActivitySummary from '@/components/AgentActivitySummary.vue'
import GameBar from '@/components/GameBar.vue'
import {
  compactionOutputOf,
  groupTranscriptParts,
  isReasoningPart,
  mediaToolNameOf,
  toolPartNameOf,
  type TranscriptSegment,
} from '@/lib/agentTranscript'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import { UserCircleIcon } from '@heroicons/vue/24/outline'

const agentMode = useAgentMode()
const promptStore = usePromptStore()
const mediaRuns = useMediaAgentRuns()

const panel = ref<HTMLElement | null>(null)

// The game bar and the game-specific empty state belong to the preset that works
// on a managed game folder, not to Agent Mode in general.
const isGameAgent = computed(() => agentMode.agentWorkspaceKind === 'games')

function messageText(message: UIMessage): string {
  return (
    message.parts
      ?.filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n\n') ?? ''
  )
}

// The AI SDK grows a part by mutating it, so the same object reference would
// leave AgentMessagePart showing whatever the part held when it mounted — the
// hazard ChatToolDisplay works around by taking `state`/`input` as their own
// props. A copy per render generalizes that: every mutated field (streaming
// text, tool state, output) arrives as a changed prop.
function asPart(part: unknown): UIMessagePart<UIDataTypes, UITools> {
  return { ...(part as object) } as UIMessagePart<UIDataTypes, UITools>
}

// ── Folding finished work ────────────────────────────────────────────────────
//
// Reasoning blocks and tool cards are what the agent did, not what it produced,
// and a single request makes dozens of them. Once the turn is over they collapse
// into one summary line; a part carrying something to look at stays out of the
// fold.
function segmentsOf(message: UIMessage): TranscriptSegment[] {
  // `step-start` is the SDK's step bookkeeping and renders nothing, so it is
  // dropped rather than left to split a run of foldable parts in two.
  const parts = (message.parts ?? []).filter((part) => part.type !== 'step-start')
  return groupTranscriptParts(parts, {
    messageId: message.id,
    live: agentMode.processing && message.id === agentMode.messages.at(-1)?.id,
    foldable: isFoldable,
  })
}

function isFoldable(part: unknown): boolean {
  if (isReasoningPart(part)) return true
  if (toolPartNameOf(part) === undefined) return false
  // Compaction is its own notice, media tools render what they generated, and a
  // browser screenshot is only ever visible here — none of it is noise.
  if (compactionOutputOf(part)) return false
  if (mediaToolNameOf(part)) return false
  const toolCallId = (part as { toolCallId?: string }).toolCallId
  return !(toolCallId && agentMode.toolImages[toolCallId]?.length)
}

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
  if (isReasoningPart(lastPart) && lastPart.state !== 'done') return 'Thinking…'
  if (lastPart.type === 'text' && lastPart.state === 'streaming') return 'Writing response…'
  const toolName = toolPartNameOf(lastPart)
  if (toolName) {
    if (lastPart.state === 'input-streaming' || lastPart.state === 'input-available') {
      // A delegated media call knows more than its own name: say which step of
      // the nested run is in flight instead of a generic "Creating media…".
      return (
        mediaRuns.activeStepLabel(lastPart.toolCallId) ?? toolActionLabel(toolName, lastPart.input)
      )
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
