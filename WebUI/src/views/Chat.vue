<template>
  <button
    v-if="showScrollButton"
    class="absolute bottom-65 left-1/2 transform -translate-x-1/2 bg-background text-foreground p-2 rounded-full shadow-lg z-50 hover:bg-muted transition-colors"
    @click="scrollToBottom()"
    title="Scroll to bottom"
  >
    <svg class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
      <path stroke-linecap="round" stroke-linejoin="round" d="M19 14l-7 7m0 0l-7-7m7 7V3" />
    </svg>
  </button>
  <div
    v-if="
      (activeConversation && activeConversation.length > 0) ||
      openAiCompatibleChat.processing ||
      hasActiveChatActivity ||
      hasPendingConfirmation
    "
    id="chatPanel"
    ref="chatPanel"
    class="flex-1 overflow-y-auto px-4 py-6 flex flex-col gap-6 relative"
    @scroll="handleScroll"
  >
    <!-- eslint-disable vue/require-v-for-key -->
    <!-- pt-20 reserves space for the fixed "Show History" button (App.vue) so short
         chats don't sit under it. For long chats this padding just scrolls out of
         view, so no JS overflow detection is needed. -->
    <div class="w-full max-w-4xl mx-auto flex flex-col gap-6 pt-20">
      <template v-for="(message, i) in activeConversation">
        <!-- eslint-enable -->
        <div v-if="message.role === 'user'" class="flex items-start gap-3">
          <UserCircleIcon :class="textInference.iconSizeClass" class="text-foreground/90" />
          <div class="flex flex-col gap-3 max-w-4/5 bg-muted rounded-md px-4 py-3">
            <p class="text-muted-foreground" :class="textInference.nameSizeClass">
              {{ languages.ANSWER_USER_NAME }}
            </p>
            <img
              v-if="
                message.parts
                  .toReversed()
                  .find((part) => part.type === 'file' && part.mediaType?.startsWith('image/'))
              "
              :src="
                (
                  message.parts
                    .toReversed()
                    .find(
                      (part) => part.type === 'file' && part.mediaType?.startsWith('image/'),
                    ) as { url?: string }
                )?.url
              "
              alt="Generated Image"
            />
            <MarkdownRenderer
              :class="textInference.fontSizeClass"
              :content="getMessageTextForCopy(message)"
              :on-copy="copyText"
            />
            <button
              class="flex items-center gap-1 text-xs text-muted-foreground mt-1"
              :title="languages.COM_COPY"
              @click="copyText(getMessageTextForCopy(message))"
            >
              <span class="svg-icon i-copy w-4 h-4"></span>
              <span>{{ languages.COM_COPY }}</span>
            </button>
          </div>
        </div>
        <div
          v-else-if="message.role === 'assistant'"
          role="article"
          aria-label="Assistant response"
          class="flex items-start gap-3"
        >
          <img :class="textInference.iconSizeClass" src="../assets/svg/ai-icon.svg" />
          <div class="flex flex-col gap-3 max-w-[90%] w-full text-wrap wrap-break-word">
            <div class="flex items-center gap-2">
              <p class="text-muted-foreground mt-0.75" :class="textInference.nameSizeClass">
                {{ languages.ANSWER_AI_NAME }}
              </p>
              <div
                v-if="(message.metadata as { model?: string }).model"
                class="flex items-center gap-2"
              >
                <span
                  class="bg-secondary text-foreground font-sans rounded-md px-1 py-1"
                  :class="textInference.nameSizeClass"
                >
                  {{
                    message.metadata?.model?.endsWith('.gguf')
                      ? (message.metadata?.model?.split('/').at(-1)?.split('.gguf')[0] ??
                        message.metadata?.model)
                      : message.metadata?.model
                  }}
                </span>
                <!-- Display RAG source if available -->
                <span
                  v-if="
                    (message.metadata as { ragSource?: string })?.ragSource ||
                    ragSourcePerMessageId[message.id]
                  "
                  @click="
                    showRagSourcePerMessageId[message.id] = !showRagSourcePerMessageId[message.id]
                  "
                  class="bg-primary text-foreground font-sans rounded-md px-1 py-1 cursor-pointer"
                  :class="textInference.nameSizeClass"
                >
                  Source Docs
                  <button class="ml-1">
                    <img
                      v-if="showRagSourcePerMessageId[message.id]"
                      src="../assets/svg/arrow-up.svg"
                      class="w-3 h-3"
                    />
                    <img v-else src="../assets/svg/arrow-down.svg" class="w-3 h-3" />
                  </button>
                </span>
              </div>
            </div>

            <!-- RAG Source Details (collapsible) -->
            <div
              v-if="
                showRagSourcePerMessageId[message.id] &&
                (message.metadata?.ragSource || ragSourcePerMessageId[message.id])
              "
              class="my-2 text-muted-foreground border-l-2 border-primary pl-2 flex flex-row gap-1"
              :class="textInference.fontSizeClass"
            >
              <div class="font-bold">{{ i18nState.RAG_SOURCE }}:</div>
              <div class="whitespace-pre-wrap">
                {{ message.metadata?.ragSource || ragSourcePerMessageId[message.id] }}
              </div>
            </div>
            <div
              class="ai-answer chat-content flex flex-col gap-2"
              :class="textInference.fontSizeClass"
            >
              <template
                v-for="(part, partIndex) in message.parts"
                :key="`${message.id}-${part.type}-${partIndex}`"
              >
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
                  :streaming="
                    i === activeConversation.length - 1 && openAiCompatibleChat.reasoningInProgress
                  "
                  :liveStartedAt="openAiCompatibleChat.reasoningStartedAt"
                  :onCopy="copyText"
                />

                <!-- Text part -->
                <template v-else-if="part.type === 'text'">
                  <MarkdownRenderer
                    role="region"
                    aria-label="Assistant reply"
                    :content="stripAipgMediaImages((part as any).text ?? '')"
                    :on-copy="copyText"
                  />
                </template>

                <!-- Tool parts -->
                <template v-else-if="isToolUIPart(part)">
                  <template v-if="isAipgTool(part) && toolPartNameOf(part) === 'comfyUI'">
                    <div>
                      <span
                        v-if="part.state === 'input-streaming' && !toolInputRecord(part).workflow"
                        >Generating…</span
                      >
                      <span v-else
                        >Generating using the preset
                        <b>{{ toolInputRecord(part).workflow ?? 'unknown' }}</b></span
                      >
                      <br />
                      <br />
                      <span
                        ><em>{{ toolInputRecord(part).prompt ?? '' }}</em></span
                      >
                      <ChatWorkflowResult
                        :images="getToolImages(part)"
                        :processing="getToolProcessing(part)"
                        :currentState="getToolCurrentState(part)"
                        :stepText="getToolStepText(part)"
                        :toolCallId="(part as any).toolCallId"
                      />
                    </div>
                  </template>
                  <template
                    v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'comfyUiImageEdit'"
                  >
                    <div>
                      <span
                        v-if="part.state === 'input-streaming' && !toolInputRecord(part).workflow"
                        >Editing…</span
                      >
                      <span v-else
                        >Editing using the preset
                        <b>{{ toolInputRecord(part).workflow ?? 'unknown' }}</b></span
                      >
                      <br />
                      <br />
                      <span
                        ><em>{{ toolInputRecord(part).prompt ?? '' }}</em></span
                      >
                      <ChatWorkflowResult
                        :images="getToolImages(part)"
                        :processing="getToolProcessing(part)"
                        :currentState="getToolCurrentState(part)"
                        :stepText="getToolStepText(part)"
                        :toolCallId="(part as any).toolCallId"
                      />
                    </div>
                  </template>
                  <!-- Thin media delegation tool: live progress is media-agent-event
                       (mediaAgentRuns, keyed by toolCallId); the settled card reads
                       the condensed tool output. Direct comfyUI / comfyUiImageEdit
                       parent tools still live-progress from the Image Gen gallery
                       (renderer-origin in-process runs). -->
                  <template v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'media'">
                    <div>
                      <span
                        v-if="part.state === 'input-streaming' && !toolInputRecord(part).request"
                        >Creating media…</span
                      >
                      <span v-else>
                        Creating media:
                        <em>{{ toolInputRecord(part).request ?? '' }}</em>
                      </span>
                      <MediaAgentTimeline
                        class="mt-2"
                        :tool-call-id="(part as any).toolCallId"
                        :fallback-steps="(part as any).output?.steps"
                      />
                      <div
                        v-if="
                          part.state === 'output-available' &&
                          (part as any).output?.success === false
                        "
                        class="mt-2 text-sm text-destructive"
                      >
                        {{ (part as any).output?.message ?? 'Media generation failed.' }}
                      </div>
                      <ChatWorkflowResult
                        :images="getToolImages(part)"
                        :processing="getToolProcessing(part)"
                        :currentState="getToolCurrentState(part)"
                        :stepText="getToolStepText(part)"
                        :toolCallId="(part as any).toolCallId"
                      />
                    </div>
                  </template>
                  <template
                    v-else-if="
                      isAipgTool(part) && toolPartNameOf(part) === 'visualizeObjectDetections'
                    "
                  >
                    <div>
                      <div
                        v-if="
                          part.state === 'output-available' &&
                          (part as any).output?.annotatedImageUrl
                        "
                      >
                        <img
                          :src="(part as any).output.annotatedImageUrl"
                          alt="Annotated image with object detections"
                          class="max-w-full rounded-md border-2 border-border"
                        />
                      </div>
                      <div
                        v-else-if="
                          part.state === 'input-streaming' || part.state === 'input-available'
                        "
                      >
                        <span class="text-muted-foreground">Visualizing object detections...</span>
                      </div>
                    </div>
                  </template>
                  <template
                    v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'captureScreenshot'"
                  >
                    <div>
                      <div
                        v-if="part.state === 'output-available' && (part as any).output?.dataUri"
                      >
                        <span class="text-muted-foreground">
                          Captured screenshot of
                          <b>{{ (part as any).output?.windowName ?? 'window' }}</b>
                        </span>
                        <img
                          :src="(part as any).output.dataUri"
                          :alt="`Screenshot of ${(part as any).output?.windowName ?? 'window'}`"
                          class="mt-2 max-w-full rounded-md border-2 border-border"
                        />
                      </div>
                      <div
                        v-else-if="
                          part.state === 'input-streaming' || part.state === 'input-available'
                        "
                      >
                        <span class="text-muted-foreground">Capturing screenshot...</span>
                      </div>
                    </div>
                  </template>
                  <template
                    v-else-if="isAipgTool(part) && toolPartNameOf(part) === 'screenshotWebPage'"
                  >
                    <div>
                      <div
                        v-if="part.state === 'output-available' && (part as any).output?.dataUri"
                      >
                        <span class="text-muted-foreground">Captured web page</span>
                        <img
                          :src="(part as any).output.dataUri"
                          alt="Screenshot of the web page"
                          class="mt-2 max-w-full rounded-md border-2 border-border"
                        />
                      </div>
                      <div
                        v-else-if="
                          part.state === 'input-streaming' || part.state === 'input-available'
                        "
                      >
                        <span class="text-muted-foreground">Capturing web page...</span>
                      </div>
                    </div>
                  </template>
                  <template
                    v-else-if="
                      isAipgTool(part) && toolPartNameOf(part) === 'synthesizeTextToSpeech'
                    "
                  >
                    <div>
                      <ChatTtsToolResult
                        v-if="part.state === 'output-available'"
                        :output="(part as any).output"
                      />
                      <div
                        v-else-if="
                          part.state === 'input-streaming' || part.state === 'input-available'
                        "
                      >
                        <span class="text-muted-foreground">Synthesizing speech…</span>
                      </div>
                    </div>
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

              <!-- In-turn status inside the assistant bubble: thinking / tool /
                   post-image-gen "reloading chat model" etc. Hidden while image
                   generation is processing (ChatWorkflowResult shows that inline). -->
              <ChatActivityIndicator
                v-if="
                  i === activeConversation.length - 1 &&
                  hasActiveChatActivity &&
                  !imageGeneration.processing
                "
                :conversation-key="conversations.activeKey"
              />

              <!-- Inline human-in-the-loop confirmation (e.g. Home Agent self-config).
                   Mirrors remote-channel confirmations into the desktop window so
                   the app never looks stuck while a tool awaits approval. -->
              <ChatConfirmation
                v-if="i === activeConversation.length - 1 && hasPendingConfirmation"
                :conversation-key="conversations.activeKey"
              />
            </div>
            <div
              v-if="messageHasVisibleContent(message)"
              class="answer-tools flex gap-3 items-center text-muted-foreground"
            >
              <button
                class="flex items-end"
                :title="languages.COM_COPY"
                @click="copyText(getMessageTextForCopy(message))"
              >
                <span class="svg-icon i-copy w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_COPY }}</span>
              </button>
              <button
                v-if="speakAvailable"
                class="flex items-end"
                title="Speak"
                :disabled="openAiCompatibleChat.processing"
                :class="{ 'opacity-50 cursor-not-allowed': openAiCompatibleChat.processing }"
                @click="toggleSpeak(message)"
              >
                <span
                  class="svg-icon w-4 h-4"
                  :class="speakingMessageId === message.id ? 'i-stop' : 'i-speaker'"
                ></span>
                <span class="text-xs ml-1">{{
                  speakingMessageId === message.id ? 'Stop' : 'Speak'
                }}</span>
              </button>
              <button
                class="flex items-end"
                :title="languages.COM_REGENERATE"
                @click="() => openAiCompatibleChat.regenerate(message.id)"
                v-if="i + 1 == activeConversation.length"
                :disabled="openAiCompatibleChat.processing"
                :class="{ 'opacity-50 cursor-not-allowed': openAiCompatibleChat.processing }"
              >
                <span class="svg-icon i-refresh w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_REGENERATE }}</span>
              </button>
              <button
                class="flex items-end"
                :title="languages.COM_DELETE"
                @click="
                  () => {
                    openAiCompatibleChat.removeMessage(message.id)
                  }
                "
              >
                <span class="svg-icon i-delete w-4 h-4"></span>
                <span class="text-xs ml-1">{{ languages.COM_DELETE }}</span>
              </button>
            </div>
            <div
              v-if="textInference.metricsEnabled && message.metadata?.timings"
              class="metrics-info text-xs text-muted-foreground"
            >
              <span class="mr-2">{{ message.metadata?.timings.predicted_n }} Tokens</span>
              <span class="mr-2">⋅</span>
              <span class="mr-2"
                >{{ message.metadata?.timings.predicted_per_second.toFixed(2) }} Tokens/s</span
              >
              <span class="mr-2">⋅</span>
              <span class="mr-2"
                >1st Token Time: {{ message.metadata?.timings.prompt_ms.toFixed(2) }}ms</span
              >
            </div>
          </div>
        </div>
      </template>

      <!-- Standalone status for the pre-bubble phase (backend/model prep before the
           assistant message exists). Once the assistant bubble appears, the
           indicator lives inside it (above) instead, to avoid a duplicate avatar. -->
      <ChatActivityIndicator
        v-if="hasActiveChatActivity && !lastMessageIsAssistant"
        :conversation-key="conversations.activeKey"
        with-avatar
      />
      <ChatConfirmation
        v-if="hasPendingConfirmation && !lastMessageIsAssistant"
        :conversation-key="conversations.activeKey"
        with-avatar
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import * as toast from '@/assets/js/toast.ts'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { useTextInference } from '@/assets/js/store/textInference.ts'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import { usePromptStore } from '@/assets/js/store/promptArea.ts'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useErrors } from '@/assets/js/store/errors'
import { createAppError } from '@/assets/js/errors/appError'
import {
  pendingVoiceTurn,
  speak,
  speakRepliesAvailable,
  speakingMessageId,
  stopSpeaking,
} from '@/assets/js/speech/speechIO'
import ChatWorkflowResult from '@/components/ChatWorkflowResult.vue'
import MediaAgentTimeline from '@/components/MediaAgentTimeline.vue'
import ChatMcpToolDisplay from '@/components/ChatMcpToolDisplay.vue'
import ChatToolDisplay from '@/components/ChatToolDisplay.vue'
import ChatWebBrowseDisplay, { type WebBrowseEntry } from '@/components/ChatWebBrowseDisplay.vue'
import ChatReasoningDisplay from '@/components/ChatReasoningDisplay.vue'
import ChatActivityIndicator from '@/components/ChatActivityIndicator.vue'
import ChatConfirmation from '@/components/ChatConfirmation.vue'
import ChatTtsToolResult from '@/components/ChatTtsToolResult.vue'
import { useConversations } from '@/assets/js/store/conversations'
import { useActivities } from '@/assets/js/store/activities'
import { useConfirmations } from '@/assets/js/store/confirmations'
import {
  useImageGenerationPresets,
  type MediaItem,
  type GenerateState,
} from '@/assets/js/store/imageGenerationPresets'
import { useMediaAgentRuns } from '@/assets/js/store/mediaAgentRuns'
import { ensureMediaAgentEventWiring } from '@/assets/js/agents/mediaAgent'
import { DynamicToolUIPart, isToolUIPart, ToolUIPart } from 'ai'
import { aipgTools, AipgTools } from '@/assets/js/tools/tools'
import { toolPartNameOf } from '@/lib/agentTranscript'
import {
  isAipgChatToolPart,
  isChatMediaToolPart,
  isChatMcpToolPart,
  isChatWebBrowseToolPart,
} from '@/lib/chatToolParts'
import { UserCircleIcon } from '@heroicons/vue/24/outline'

const openAiCompatibleChat = useOpenAiCompatibleChat()
const speakAvailable = computed(() => speakRepliesAvailable())
const textInference = useTextInference()
const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const mediaAgentRuns = useMediaAgentRuns()
const conversations = useConversations()
const activities = useActivities()
const confirmations = useConfirmations()
const errors = useErrors()

// True while any activity (backend prep, thinking, tools, generation) is running
// for the active conversation, so the chat panel stays visible to host the
// in-turn activity indicator even before the first token streams.
const hasActiveChatActivity = computed(
  () => activities.chatActivity(conversations.activeKey, ['generation']) !== null,
)

// A tool (e.g. Home Agent self-config) is awaiting an inline yes/no for the
// active conversation. Drives the ChatConfirmation card; also mirrors a pending
// remote-channel confirmation into the desktop window.
const hasPendingConfirmation = computed(
  () => confirmations.forConversation(conversations.activeKey) !== null,
)

// Whether a message already shows something (streamed text, reasoning, or a tool
// part). Used to suppress action buttons / show the activity indicator inside an
// otherwise-empty in-progress assistant bubble.
function messageHasVisibleContent(message: { parts?: { type: string; text?: string }[] }): boolean {
  return (
    message.parts?.some((part) => {
      if (part.type === 'text') return stripAipgMediaImages(part.text ?? '').length > 0
      if (part.type === 'reasoning') return true
      return isToolUIPart(part as Parameters<typeof isToolUIPart>[0])
    }) ?? false
  )
}

// True when the last message is an assistant turn (its bubble already hosts the
// activity indicator), so the standalone bottom indicator is only used earlier
// (backend prep, before the assistant bubble exists).
const lastMessageIsAssistant = computed(
  () => activeConversation.value?.[activeConversation.value.length - 1]?.role === 'assistant',
)

const i18nState = useI18N().state
const languages = i18nState
const autoScrollEnabled = ref(true)
const showScrollButton = ref(false)
const chatPanel = ref<HTMLElement | null>(null)

const activeConversation = computed(() => openAiCompatibleChat.messages)
const showRagSourcePerMessageId = reactive<Record<string, boolean>>({})

const ragSourcePerMessageId = reactive<Record<string, string>>({})
const aipgToolNames = new Set(Object.keys(aipgTools))

// Inline ![alt](aipg-media://…) tokens are also rendered as a ChatWorkflowResult
// tool-part below, so strip them from the text part to avoid duplicate images.
const AIPG_IMAGE_MD_RE_DISPLAY = /!\[[^\]]*]\(aipg-media:\/\/[^)]+\)/g
function stripAipgMediaImages(text: string): string {
  return text.replace(AIPG_IMAGE_MD_RE_DISPLAY, '').trim()
}

// Track progress for active tool calls
const toolProgressMap = reactive<
  Record<
    string,
    {
      processing: boolean
      currentState?: GenerateState
      stepText?: string
      images: MediaItem[]
      initialImageIds: Set<string> // Track which image IDs existed when tool call started
    }
  >
>({})

defineExpose({
  scrollToBottom,
})

// The Audio mode streams into this same view (TTS audio bubbles, STT transcripts),
// so it submits and cancels through the same handlers.
const chatLikeModes: ChatLikeModeType[] = ['chat', 'audio']

onMounted(() => {
  ensureMediaAgentEventWiring()
  for (const mode of chatLikeModes) {
    promptStore.registerSubmitCallback(mode, handlePromptSubmit)
    promptStore.registerCancelCallback(mode, handleCancel)
  }
})

// When async content (e.g. a generated picture) finishes loading, the panel
// grows after the initial scroll. Re-pin to the bottom on such load events so
// the view doesn't lag behind. `load` doesn't bubble but does fire in the
// capture phase, so a single listener on the container catches all images.
watch(chatPanel, (el, _old, onCleanup) => {
  if (!el) return
  const onContentLoad = () => {
    if (autoScrollEnabled.value) nextTick(() => scrollToBottom())
  }
  el.addEventListener('load', onContentLoad, true)
  onCleanup(() => el.removeEventListener('load', onContentLoad, true))
})

onUnmounted(() => {
  for (const mode of chatLikeModes) {
    promptStore.unregisterSubmitCallback(mode)
    promptStore.unregisterCancelCallback(mode)
  }
})

watch(
  () => openAiCompatibleChat.messages,
  (messages) => {
    // Initialize RAG source display state from message metadata
    if (messages) {
      messages.forEach((message) => {
        const ragSource = (message.metadata as { ragSource?: string })?.ragSource
        if (ragSource && !ragSourcePerMessageId[message.id]) {
          ragSourcePerMessageId[message.id] = ragSource
          // Default to collapsed state
          showRagSourcePerMessageId[message.id] = false
        }
        if (message.role !== 'assistant' || !Array.isArray(message.parts)) return
        for (const part of message.parts) {
          if (toolPartNameOf(part) !== 'media') continue
          const id = (part as { toolCallId?: string }).toolCallId
          if (!id) continue
          if (part.state === 'output-available' && (part as { output?: unknown }).output != null) {
            mediaAgentRuns.endRun(id, 'done')
          }
          if (part.state === 'output-error') mediaAgentRuns.endRun(id, 'failed')
        }
      })
    }

    if (autoScrollEnabled.value) {
      nextTick(() => scrollToBottom())
    }
  },
  { deep: true, immediate: true },
)

async function handlePromptSubmit(prompt: string) {
  const question = prompt.trim()
  if (question == '') {
    errors.report(
      createAppError({
        category: 'validation',
        code: 'inference/empty-prompt',
        userMessage: i18nState.ANSWER_ERROR_NOT_PROMPT,
        surface: 'toast',
      }),
    )
    promptStore.promptSubmitted = false
    return
  }
  try {
    nextTick(scrollToBottom)
    await openAiCompatibleChat.generate(question)
  } catch (error) {
    // generate() already reported via the sink; this catch just unblocks the UI
    // (and the sink dedupes if we report an already-handled AppError). Model-load
    // failures are surfaced separately via toast at the backend-readiness
    // chokepoint (textInference.ensureBackendReadiness).
    promptStore.promptSubmitted = false
    errors.report(error, { category: 'inference', code: 'inference/generate-failed' })
  }
}

function handleCancel() {
  // Fire off stop requests without awaiting to immediately unblock UI
  if (openAiCompatibleChat.processing) {
    openAiCompatibleChat.stop()
  }
  // Also cancel any ongoing generation through the main-process runner
  void window.electronAPI.artifact.cancel()

  // Immediately reset prompt state to unblock UI
  promptStore.promptSubmitted = false
}

let lastScrollTop = 0

function handleScroll(e: Event) {
  const target = e.target as HTMLElement
  const scrollTop = target.scrollTop
  const distanceFromBottom = target.scrollHeight - (scrollTop + target.clientHeight)

  showScrollButton.value = distanceFromBottom > 60

  // Only a genuine upward scroll (user dragging up) disables autoscroll.
  // Programmatic scroll-to-bottom and content growth only move scrollTop down or
  // leave it unchanged, so the smooth animation can't wrongly disable autoscroll.
  if (scrollTop < lastScrollTop - 1) {
    autoScrollEnabled.value = false
  } else if (distanceFromBottom <= 35) {
    autoScrollEnabled.value = true
  }
  lastScrollTop = scrollTop
}

function scrollToBottom(smooth = true) {
  if (chatPanel.value) {
    chatPanel.value.scrollTo({
      top: chatPanel.value.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    })
  }
}

function copyText(text: string) {
  navigator.clipboard
    .writeText(text)
    .then(() => {
      toast.success(i18nState.COM_COPY_SUCCESS_TIP)
    })
    .catch((e) => console.error('Error while copying text to clipboard', e))
}

function getMessageTextForCopy(message: { parts: { type: string; text?: string }[] }): string {
  // Mirror the sanitization applied to the rendered MarkdownRenderer
  // (`stripAipgMediaImages`) so copied text matches what the user actually
  // sees — otherwise embedded `aipg-media://` image tokens leak into the
  // clipboard even though they are stripped on screen.
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => stripAipgMediaImages(part.text ?? ''))
    .filter((t) => t.length > 0)
    .join('\n\n')
}

function toggleSpeak(message: { id: string; parts: { type: string; text?: string }[] }): void {
  if (speakingMessageId.value === message.id) {
    stopSpeaking()
    return
  }
  void speak({ text: getMessageTextForCopy(message), messageId: message.id })
}

// Auto-play the assistant reply when the user's input came from speech.
watch(
  () => openAiCompatibleChat.processing,
  (processing, wasProcessing) => {
    if (!(wasProcessing && !processing)) return
    // "Speak replies" for the active preset (edited on the Text To Speech tool row).
    if (!speakRepliesAvailable() || !textInference.speakRepliesAllowed()) return
    if (!pendingVoiceTurn.value) return

    pendingVoiceTurn.value = false

    const messages = openAiCompatibleChat.messages
    const last = messages?.[messages.length - 1]
    if (!last || last.role !== 'assistant') return

    const text = getMessageTextForCopy(last)
    if (text.trim().length > 0) {
      void speak({ text, messageId: last.id })
    }
  },
)

// Direct parent-turn comfy tools still live-progress through the Image Gen
// gallery. The NL `media` tool does not — its images are the condensed output
// and mediaAgentRuns timeline.
function isDirectComfyToolPart(part: { type: string; toolName?: string }): boolean {
  const name = toolPartNameOf(part)
  return name === 'comfyUI' || name === 'comfyUiImageEdit'
}

function isMediaToolPart(part: { type: string; toolName?: string }): boolean {
  return isChatMediaToolPart(part)
}

function toolInputRecord(part: { input?: unknown }): Record<string, unknown> {
  return part.input && typeof part.input === 'object' && !Array.isArray(part.input)
    ? (part.input as Record<string, unknown>)
    : {}
}

function getToolImages(part: ToolUIPart<AipgTools> | DynamicToolUIPart): MediaItem[] {
  if (!isMediaToolPart(part)) return []
  const toolCallId = part.toolCallId

  if (toolPartNameOf(part) === 'media') {
    const fromRun = mediaAgentRuns
      .run(toolCallId)
      ?.steps.flatMap((step) => step.media)
      .filter((item) => item.state === 'done')
    if (fromRun && fromRun.length > 0) return fromRun
    if (part.state === 'output-available') {
      const output = part.output as { images?: unknown[] } | undefined
      if (!output?.images) return []
      return output.images.map((img) => ({
        ...(img as MediaItem),
        state: 'done' as const,
      }))
    }
    return []
  }

  const progress = toolProgressMap[toolCallId]

  // Direct comfyUI / edit tools: live images come from the Image Gen gallery
  // (those tools still pre-register stubs / mutate generatedImages).
  if (progress && progress.images.length > 0) {
    return progress.images
  }

  if (part.state === 'output-available') {
    const output = part.output as { images?: unknown[] } | undefined
    if (!output?.images) return []
    return output.images.map((img) => ({
      ...(img as MediaItem),
      state: 'done' as const,
    }))
  }

  return []
}

function getToolProcessing(part: ToolUIPart<AipgTools> | DynamicToolUIPart): boolean {
  if (part.state === 'output-available' || part.state === 'output-error') return false
  const toolCallId = part.toolCallId
  const progress = toolProgressMap[toolCallId]

  // If we have progress tracking, use that
  if (progress) {
    return progress.processing
  }

  // Otherwise, check part state
  return part.state === 'input-streaming' || part.state === 'input-available'
}

function getToolCurrentState(
  part: ToolUIPart<AipgTools> | DynamicToolUIPart,
): GenerateState | undefined {
  const toolCallId = part.toolCallId
  const progress = toolProgressMap[toolCallId]

  if (progress && progress.currentState) {
    return progress.currentState as GenerateState
  }

  return undefined
}

function getToolStepText(part: ToolUIPart<AipgTools> | DynamicToolUIPart): string | undefined {
  const toolCallId = part.toolCallId
  const progress = toolProgressMap[toolCallId]

  if (progress && progress.stepText) {
    return progress.stepText
  }

  return undefined
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

type ChatMessage = NonNullable<typeof activeConversation.value>[number]

function webBrowsePartsOf(message: ChatMessage) {
  return (message.parts ?? []).filter((part) =>
    isWebBrowsePart(part as ToolUIPart<AipgTools> | DynamicToolUIPart),
  ) as ToolUIPart<AipgTools>[]
}

// Reasoning is "in progress" only when the store — which watches the raw chunk
// stream — reports reasoning is the model's current output, on the last message
// of the turn. The store flag is authoritative, so the aggregated block below
// binds straight to it rather than inferring from part positions or the per-delta
// `reasoningFinished` timestamp (bumped to "now" every delta, so it always looks
// recent).
type ReasoningPart = {
  type: 'reasoning'
  text?: string
  providerMetadata?: { aipg?: { reasoningStarted?: number; reasoningFinished?: number } }
}

function reasoningPartsOf(message: ChatMessage): ReasoningPart[] {
  return (message.parts ?? []).filter((part) => part.type === 'reasoning') as ReasoningPart[]
}

// The reasoning block is aggregated across all of a message's reasoning parts and
// rendered once, at the first one — so we never show the "Reasoned for…" pill
// more than once per turn.
function isFirstReasoningPart(message: ChatMessage, partIndex: number): boolean {
  return (message.parts ?? []).findIndex((part) => part.type === 'reasoning') === partIndex
}

function mergedReasoningText(message: ChatMessage): string {
  return reasoningPartsOf(message)
    .map((part) => (part.text ?? '').trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

function reasoningStartedAtFor(message: ChatMessage): number | undefined {
  const starts = reasoningPartsOf(message)
    .map((part) => part.providerMetadata?.aipg?.reasoningStarted)
    .filter((value): value is number => value != null)
  return starts.length > 0 ? Math.min(...starts) : undefined
}

function reasoningFinishedAtFor(message: ChatMessage): number | undefined {
  const finishes = reasoningPartsOf(message)
    .map((part) => part.providerMetadata?.aipg?.reasoningFinished)
    .filter((value): value is number => value != null)
  return finishes.length > 0 ? Math.max(...finishes) : undefined
}

// Renders the aggregated component only at the position of the first browse part
// so it appears once (in order) rather than per tool call.
function isFirstWebBrowsePart(message: ChatMessage, partIndex: number): boolean {
  const parts = message.parts ?? []
  const firstIndex = parts.findIndex((part) =>
    isWebBrowsePart(part as ToolUIPart<AipgTools> | DynamicToolUIPart),
  )
  return firstIndex === partIndex
}

function webBrowseEntriesFor(message: ChatMessage): WebBrowseEntry[] {
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

// Watch for new tool calls starting to initialize their image tracking
watch(
  () => activeConversation.value,
  (messages) => {
    if (!messages) return

    // Find tool calls that just started (input-streaming or input-available)
    messages.forEach((msg) => {
      msg.parts.forEach((part) => {
        if (isDirectComfyToolPart(part) && 'toolCallId' in part) {
          const toolCallId = part.toolCallId
          const state = part.state

          // If this tool call just started and we haven't initialized it yet
          if (
            (state === 'input-streaming' || state === 'input-available') &&
            !toolProgressMap[toolCallId]
          ) {
            // Record the current set of image IDs to exclude them from this tool call's images
            const currentImageIds = new Set(imageGeneration.generatedImages.map((img) => img.id))
            toolProgressMap[toolCallId] = {
              processing: true,
              images: [],
              initialImageIds: currentImageIds,
            }
          }
        }
      })
    })
  },
  { deep: true },
)

// Watch imageGeneration store to track progress for active tool calls
watch(
  () => [
    imageGeneration.generatedImages,
    imageGeneration.processing,
    imageGeneration.currentState,
    imageGeneration.stepText,
  ],
  () => {
    // Find active tool calls that are processing
    const activeToolParts =
      activeConversation.value
        ?.flatMap((msg) => msg.parts)
        .filter(
          (part) =>
            isDirectComfyToolPart(part) &&
            'state' in part &&
            (part.state === 'input-streaming' || part.state === 'input-available'),
        )
        .map((part) => ({
          toolCallId: (part as { toolCallId: string }).toolCallId,
          part,
        })) || []

    // Update progress for each active tool call
    activeToolParts.forEach(({ toolCallId }) => {
      const progress = toolProgressMap[toolCallId]
      if (!progress) return

      // Only get images that were created for this tool call (not in initial set)
      const toolCallImages = imageGeneration.generatedImages
        .filter((img) => !progress.initialImageIds.has(img.id))
        .filter(
          (img) => img.state === 'queued' || img.state === 'generating' || img.state === 'done',
        )
        // Filter out items without valid URL based on type
        .filter((img) => {
          if (img.type === 'image') return img.imageUrl && img.imageUrl.trim() !== ''
          if (img.type === 'video') return img.videoUrl && img.videoUrl.trim() !== ''
          if (img.type === 'model3d') return img.model3dUrl && img.model3dUrl.trim() !== ''
          return false
        })
        .map((img) => ({ ...img }))

      progress.images = toolCallImages
      progress.processing = imageGeneration.processing
      progress.currentState = imageGeneration.currentState
      progress.stepText = imageGeneration.stepText
    })
  },
  { deep: true },
)

// Also watch processing state
watch(
  () => imageGeneration.processing,
  (processing) => {
    // Get the set of currently active tool call IDs (input-streaming or input-available)
    const activeToolCallIds = new Set(
      activeConversation.value
        ?.flatMap((msg) => msg.parts)
        .filter(
          (part) =>
            isDirectComfyToolPart(part) &&
            'state' in part &&
            (part.state === 'input-streaming' || part.state === 'input-available'),
        )
        .map((part) => (part as { toolCallId: string }).toolCallId) || [],
    )

    Object.keys(toolProgressMap).forEach((toolCallId) => {
      const progress = toolProgressMap[toolCallId]
      if (!progress) return

      if (processing) {
        // When processing starts, only set processing=true for active tool calls
        // This prevents completed tool calls from showing the progress indicator again
        if (activeToolCallIds.has(toolCallId)) {
          progress.processing = true
        }
      } else {
        // When processing stops, update any tool call that was processing
        // (it may no longer be "active" since its state changed to output-available)
        if (progress.processing) {
          progress.processing = false
          // Mark images as done and filter out any without valid URL
          progress.images = progress.images
            .filter((img) => {
              if (img.type === 'image') return img.imageUrl && img.imageUrl.trim() !== ''
              if (img.type === 'video') return img.videoUrl && img.videoUrl.trim() !== ''
              if (img.type === 'model3d') return img.model3dUrl && img.model3dUrl.trim() !== ''
              return false
            })
            .map((img) => ({
              ...img,
              state: 'done' as const,
            }))
        }
      }
    })
  },
)
</script>

<style>
.hljs {
  padding-left: 0.5rem;
  border-bottom-left-radius: calc(var(--radius) - 2px);
  border-bottom-right-radius: calc(var(--radius) - 2px);
}
</style>
