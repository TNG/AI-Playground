<template>
  <div
    v-if="section !== 'details' && showRagSource && ragSource"
    class="my-2 text-muted-foreground border-l-2 border-primary pl-2 flex flex-row gap-1"
    :class="textInference.fontSizeClass"
  >
    <div class="font-bold">{{ languages.RAG_SOURCE }}:</div>
    <div class="whitespace-pre-wrap">{{ ragSource }}</div>
  </div>
  <div class="ai-answer chat-content flex flex-col gap-2" :class="textInference.fontSizeClass">
    <template
      v-for="(part, partIndex) in message.parts"
      :key="`${message.id}-${part.type}-${partIndex}`"
    >
      <template v-if="shows(partIndex)">
        <!-- Reasoning part. A turn can carry several reasoning parts
         (one per agentic step, and some backends resend cumulative
         reasoning), which otherwise renders as several "Reasoned
         for…" blocks. Aggregate them into a single block rendered at
         the position of the first reasoning part (mirrors the
         web-browse aggregation below). -->
        <ChatReasoningDisplay
          v-if="part.type === 'reasoning' && isFirstReasoningPart(message, partIndex)"
          :text="mergedReasoningText(message)"
          :startedAt="reasoningStartedAtFor(message)"
          :finishedAt="reasoningFinishedAtFor(message)"
          :streaming="last && openAiCompatibleChat.reasoningInProgress"
          :liveStartedAt="openAiCompatibleChat.reasoningStartedAt"
          :onCopy="copyText"
        />

        <!-- Text part -->
        <template v-else-if="part.type === 'text'">
          <MarkdownRenderer
            role="region"
            aria-label="Assistant reply"
            :content="stripInlineMedia((part as any).text ?? '')"
            :on-copy="copyText"
          />
        </template>

        <!-- Tool parts -->
        <template v-else-if="isToolUIPart(part)">
          <template v-if="isAipgTool(part) && toolPartNameOf(part) === 'comfyUI'">
            <div v-if="section !== 'result'">
              <span v-if="part.state === 'input-streaming' && !toolInputRecord(part).workflow">{{
                languages.CHAT_TOOL_GENERATING
              }}</span>
              <span v-else
                >{{ around(languages.CHAT_TOOL_GENERATING_WITH_PRESET, 'preset')[0]
                }}<b>{{ toolInputRecord(part).workflow ?? 'unknown' }}</b
                >{{ around(languages.CHAT_TOOL_GENERATING_WITH_PRESET, 'preset')[1] }}</span
              >
              <br />
              <br />
              <span
                ><em>{{ toolInputRecord(part).prompt ?? '' }}</em></span
              >
            </div>
            <template v-if="section !== 'details'">
              <ChatWorkflowResult v-bind="toolMediaCard(part)" />
              <TurnFailureLine
                v-if="toolCallResultFailure(part)"
                :failure="toolCallResultFailure(part)!"
              />
            </template>
          </template>
          <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'comfyUiImageEdit'">
            <div v-if="section !== 'result'">
              <span v-if="part.state === 'input-streaming' && !toolInputRecord(part).workflow">{{
                languages.CHAT_TOOL_EDITING
              }}</span>
              <span v-else
                >{{ around(languages.CHAT_TOOL_EDITING_WITH_PRESET, 'preset')[0]
                }}<b>{{ toolInputRecord(part).workflow ?? 'unknown' }}</b
                >{{ around(languages.CHAT_TOOL_EDITING_WITH_PRESET, 'preset')[1] }}</span
              >
              <br />
              <br />
              <span
                ><em>{{ toolInputRecord(part).prompt ?? '' }}</em></span
              >
            </div>
            <template v-if="section !== 'details'">
              <ChatWorkflowResult v-bind="toolMediaCard(part)" />
              <TurnFailureLine
                v-if="toolCallResultFailure(part)"
                :failure="toolCallResultFailure(part)!"
              />
            </template>
          </template>
          <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'media'">
            <div v-if="section !== 'result'">
              <span v-if="part.state === 'input-streaming' && !toolInputRecord(part).request">{{
                languages.CHAT_TOOL_CREATING_MEDIA
              }}</span>
              <span v-else>
                {{ languages.CHAT_TOOL_CREATING_MEDIA_FOR }}
                <em>{{ toolInputRecord(part).request ?? '' }}</em>
              </span>
              <MediaAgentTimeline
                class="mt-2"
                :tool-call-id="(part as any).toolCallId"
                :fallback-steps="(part as any).output?.steps"
              />
            </div>
            <div v-if="section !== 'details'">
              <ChatWorkflowResult v-bind="toolMediaCard(part)" />
              <TurnFailureLine
                v-if="toolCallResultFailure(part)"
                :failure="toolCallResultFailure(part)!"
              />
            </div>
          </template>
          <template
            v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'visualizeObjectDetections'"
          >
            <div>
              <div
                v-if="part.state === 'output-available' && (part as any).output?.annotatedImageUrl"
              >
                <img
                  :src="(part as any).output.annotatedImageUrl"
                  :alt="languages.CHAT_TOOL_DETECTIONS_ALT"
                  class="max-w-full rounded-md border-2 border-border"
                />
              </div>
              <div v-else-if="part.state === 'input-streaming' || part.state === 'input-available'">
                <span class="text-muted-foreground">{{
                  languages.CHAT_TOOL_VISUALIZING_DETECTIONS
                }}</span>
              </div>
            </div>
          </template>
          <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'captureScreenshot'">
            <div>
              <div v-if="part.state === 'output-available' && (part as any).output?.dataUri">
                <span class="text-muted-foreground"
                  >{{ around(languages.CHAT_TOOL_CAPTURED_WINDOW, 'window')[0]
                  }}<b>{{ (part as any).output?.windowName ?? 'window' }}</b
                  >{{ around(languages.CHAT_TOOL_CAPTURED_WINDOW, 'window')[1] }}</span
                >
                <img
                  :src="(part as any).output.dataUri"
                  :alt="
                    fillTemplate(languages.CHAT_TOOL_WINDOW_ALT, {
                      window: (part as any).output?.windowName ?? 'window',
                    })
                  "
                  class="mt-2 max-w-full rounded-md border-2 border-border"
                />
              </div>
              <div v-else-if="part.state === 'input-streaming' || part.state === 'input-available'">
                <span class="text-muted-foreground">{{
                  languages.CHAT_TOOL_CAPTURING_SCREENSHOT
                }}</span>
              </div>
            </div>
          </template>
          <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'screenshotWebPage'">
            <div>
              <div v-if="part.state === 'output-available' && (part as any).output?.dataUri">
                <span class="text-muted-foreground">{{
                  languages.CHAT_TOOL_CAPTURED_WEB_PAGE
                }}</span>
                <img
                  :src="(part as any).output.dataUri"
                  :alt="languages.CHAT_TOOL_WEB_PAGE_ALT"
                  class="mt-2 max-w-full rounded-md border-2 border-border"
                />
              </div>
              <div v-else-if="part.state === 'input-streaming' || part.state === 'input-available'">
                <span class="text-muted-foreground">{{
                  languages.CHAT_TOOL_CAPTURING_WEB_PAGE
                }}</span>
              </div>
            </div>
          </template>
          <template
            v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'synthesizeTextToSpeech'"
          >
            <AudioArtifactCard
              v-for="artifact in ttsToolArtifacts(part, sessions.openDeletedFiles)"
              :key="artifact.id"
              :artifact="artifact"
            />
          </template>
          <template v-else-if="isWebBrowsePart(part)">
            <ChatWebBrowseDisplay
              v-if="isFirstWebBrowsePart(message, partIndex)"
              :entries="webBrowseEntriesFor(message)"
            />
          </template>
          <template v-else-if="isMcpTool(part)">
            <ChatMcpToolDisplay :part="part" :state="part.state" />
          </template>
          <template v-else>
            <ChatToolDisplay :part="part" :state="part.state" :input="part.input" />
          </template>
        </template>
      </template>
    </template>

    <!-- In a Session timeline both live in the Turn; this is the Home Agent thread view. -->
    <ChatActivityIndicator
      v-if="!section && last && hasActivity && !messageHasLiveMedia(message)"
      :conversation-key="conversationKey"
    />
    <ChatConfirmation
      v-if="!section && last && hasConfirmation"
      :conversation-key="conversationKey"
    />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { type DynamicToolUIPart, isToolUIPart, type ToolUIPart } from 'ai'
import { useActivities } from '@/assets/js/store/activities'
import { useArtifactRuns } from '@/assets/js/store/artifactRuns'
import { useConfirmations } from '@/assets/js/store/confirmations'
import { useI18N } from '@/assets/js/store/i18n'
import { useOpenAiCompatibleChat, type AipgUiMessage } from '@/assets/js/store/openAiCompatibleChat'
import { useSessions } from '@/assets/js/store/sessions'
import { useTextInference } from '@/assets/js/store/textInference'
import AudioArtifactCard from '@/components/AudioArtifactCard.vue'
import ChatActivityIndicator from '@/components/ChatActivityIndicator.vue'
import ChatConfirmation from '@/components/ChatConfirmation.vue'
import ChatMcpToolDisplay from '@/components/ChatMcpToolDisplay.vue'
import ChatReasoningDisplay from '@/components/ChatReasoningDisplay.vue'
import ChatToolDisplay from '@/components/ChatToolDisplay.vue'
import ChatWebBrowseDisplay, { type WebBrowseEntry } from '@/components/ChatWebBrowseDisplay.vue'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import TurnFailureLine from '@/components/TurnFailureLine.vue'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import MediaAgentTimeline from '@/components/MediaAgentTimeline.vue'
import { aipgTools, type AipgTools } from '@/assets/js/tools/tools'
import { toolPartNameOf } from '@/lib/agentTranscript'
import {
  isAipgChatToolPart,
  isChatMediaToolPart,
  isChatMcpToolPart,
  isChatWebBrowseToolPart,
} from '@/lib/chatToolParts'
import { copyToClipboard, stripInlineMedia } from '@/lib/chatMessageText'
import { fillTemplate } from '@/lib/fillTemplate'
import { ttsToolArtifacts } from '@/lib/audioArtifacts'
import { toolCallArtifacts, toolCallResultFailure } from '@/lib/turnArtifacts'

/** What a chat answer is made of: reasoning, text, tool cards and the media they made. */
const props = defineProps<{
  message: AipgUiMessage
  /** The newest message of the live conversation: outside a Session it hosts the turn's live status. */
  last?: boolean
  conversationKey: string
  showRagSource?: boolean
  /** Which side of the Turn this renders: a media tool's card is the Result, the rest Turn Details. */
  section?: 'details' | 'result'
  /** The parts to render; all of them when absent. */
  indexes?: readonly number[]
}>()

const openAiCompatibleChat = useOpenAiCompatibleChat()
const textInference = useTextInference()
const artifactRuns = useArtifactRuns()
const sessions = useSessions()
const activities = useActivities()
const confirmations = useConfirmations()
const languages = useI18N().state

const aipgToolNames = new Set(Object.keys(aipgTools))

const ragSource = computed(() => props.message.metadata?.ragSource)
const hasActivity = computed(
  () => activities.chatActivity(props.conversationKey, ['generation']) !== null,
)
const hasConfirmation = computed(
  () => confirmations.forConversation(props.conversationKey) !== null,
)

function around(template: string, placeholder: string): [string, string] {
  const [before, after = ''] = template.split(`{${placeholder}}`)
  return [before, after]
}

function shows(partIndex: number): boolean {
  return !props.indexes || props.indexes.includes(partIndex)
}

function copyText(text: string) {
  copyToClipboard(text, languages.COM_COPY_SUCCESS_TIP)
}

function toolInputRecord(part: { input?: unknown }): Record<string, unknown> {
  return part.input && typeof part.input === 'object' && !Array.isArray(part.input)
    ? (part.input as Record<string, unknown>)
    : {}
}

function toolMediaCard(part: ToolUIPart<AipgTools> | DynamicToolUIPart) {
  return { artifacts: toolCallArtifacts(part, artifactRuns.state, sessions.openDeletedFiles) }
}

function messageHasLiveMedia(message: { parts?: unknown[] }): boolean {
  return (message.parts ?? []).some((part) => {
    const toolPart = part as ToolUIPart<AipgTools> | DynamicToolUIPart
    return isChatMediaToolPart(toolPart) && artifactRuns.viewFor(toolPart.toolCallId).processing
  })
}

function isAipgTool(part: ToolUIPart<AipgTools> | DynamicToolUIPart): boolean {
  return isAipgChatToolPart(part, aipgToolNames)
}

function isMcpTool(part: ToolUIPart<AipgTools> | DynamicToolUIPart): part is DynamicToolUIPart {
  return isChatMcpToolPart(part)
}

// Web-browsing tool parts (browseWeb + interactWithWebPage) are aggregated into a
// single "Browsed N pages" trace element per assistant message.
function isWebBrowsePart(part: ToolUIPart<AipgTools> | DynamicToolUIPart): boolean {
  return isChatWebBrowseToolPart(part)
}

function webBrowsePartsOf(message: AipgUiMessage) {
  return (message.parts ?? []).filter((part) =>
    isWebBrowsePart(part as ToolUIPart<AipgTools> | DynamicToolUIPart),
  ) as ToolUIPart<AipgTools>[]
}

// Reasoning is "in progress" only when the store — which watches the raw chunk
// stream — reports reasoning is the model's current output, on the last message
// of the turn.
type ReasoningPart = {
  type: 'reasoning'
  text?: string
  providerMetadata?: { aipg?: { reasoningStarted?: number; reasoningFinished?: number } }
}

function reasoningPartsOf(message: AipgUiMessage): ReasoningPart[] {
  return (message.parts ?? []).filter((part) => part.type === 'reasoning') as ReasoningPart[]
}

// A turn can carry several reasoning parts (one per agentic step); they render as
// one block, at the first one.
function isFirstReasoningPart(message: AipgUiMessage, partIndex: number): boolean {
  return (message.parts ?? []).findIndex((part) => part.type === 'reasoning') === partIndex
}

function mergedReasoningText(message: AipgUiMessage): string {
  return reasoningPartsOf(message)
    .map((part) => (part.text ?? '').trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

function reasoningStartedAtFor(message: AipgUiMessage): number | undefined {
  const starts = reasoningPartsOf(message)
    .map((part) => part.providerMetadata?.aipg?.reasoningStarted)
    .filter((value): value is number => value != null)
  return starts.length > 0 ? Math.min(...starts) : undefined
}

function reasoningFinishedAtFor(message: AipgUiMessage): number | undefined {
  const finishes = reasoningPartsOf(message)
    .map((part) => part.providerMetadata?.aipg?.reasoningFinished)
    .filter((value): value is number => value != null)
  return finishes.length > 0 ? Math.max(...finishes) : undefined
}

function isFirstWebBrowsePart(message: AipgUiMessage, partIndex: number): boolean {
  const parts = message.parts ?? []
  const firstIndex = parts.findIndex((part) =>
    isWebBrowsePart(part as ToolUIPart<AipgTools> | DynamicToolUIPart),
  )
  return firstIndex === partIndex
}

function webBrowseEntriesFor(message: AipgUiMessage): WebBrowseEntry[] {
  return webBrowsePartsOf(message).map((part) => {
    const input = part.input as { url?: string; action?: string; query?: string } | undefined
    if (toolPartNameOf(part) === 'searchWeb') {
      return {
        toolCallId: part.toolCallId,
        state: part.state,
        title: input?.query ? `Search: "${input.query}"` : 'Web search',
        action: 'search',
        errorText: part.state === 'output-error' ? part.errorText : undefined,
      }
    }
    const output = part.state === 'output-available' ? (part.output as WebPageSnapshot) : undefined
    return {
      toolCallId: part.toolCallId,
      state: part.state,
      title: output?.title,
      url: output?.url,
      requestedUrl: toolPartNameOf(part) === 'browseWeb' ? input?.url : undefined,
      action: toolPartNameOf(part) === 'interactWithWebPage' ? input?.action : undefined,
      errorText: part.state === 'output-error' ? part.errorText : undefined,
    }
  })
}
</script>

<style>
.hljs {
  padding-left: 0.5rem;
  border-bottom-left-radius: calc(var(--radius) - 2px);
  border-bottom-right-radius: calc(var(--radius) - 2px);
}
</style>
