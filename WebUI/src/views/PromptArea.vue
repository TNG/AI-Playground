<template>
  <div id="prompt-area" class="text-foreground flex flex-col w-full pt-4">
    <div class="group flex flex-col items-center gap-3 text-base px-4">
      <div v-if="contextError" class="flex items-center gap-3">
        <p class="text-red-500">{{ contextError }}</p>
      </div>
      <p class="text-2xl font-bold">Let's Generate</p>
      <div class="w-full max-w-3xl flex flex-col">
        <PromptStatusBar />
        <!-- RAG Documents Display (only when RAG is enabled and has documents) -->
        <div
          v-if="
            promptStore.getCurrentMode() === 'chat' &&
            canAttachDocuments &&
            checkedRagDocuments.length > 0
          "
          class="text-xs relative top-11 z-5 -left-1 -mt-11 mx-2 mb-3 flex flex-wrap items-center gap-2 px-1 py-1"
        >
          <span class="text-muted-foreground flex items-center gap-1">
            <PaperClipIcon class="size-4" />
          </span>
          <div
            v-for="doc in checkedRagDocuments"
            :key="doc.hash"
            class="flex items-center gap-1 px-1 py-0.5 bg-primary/20 border border-primary/30 rounded-md text-foreground hover:bg-primary/30 transition-colors group"
          >
            <span class="svg-icon flex-none w-4 h-4" :class="getRagIconClass(doc.type)"></span>
            <span class="truncate max-w-[200px]" :title="doc.filename">{{ doc.filename }}</span>
            <button
              @click="textInference.updateFileCheckStatus(doc.hash, false)"
              class="ml-1 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
              title="Remove from context"
            >
              <XMarkIcon class="size-4" />
            </button>
          </div>
        </div>
        <div class="relative w-full">
          <template v-if="demoMode.enabled && isFirstPrompt">
            <Popover :open="isTextareaFocused">
              <PopoverAnchor as-child>
                <div
                  class="pointer-events-none absolute left-3 -top-2 size-1 overflow-hidden opacity-0"
                  aria-hidden="true"
                />
              </PopoverAnchor>
              <PopoverContent
                side="top"
                align="start"
                :side-offset="10"
                class="z-[40010] w-auto min-w-0 rounded-xl border-[1.5px] border-[var(--demo-popover-border)] bg-[var(--demo-popover-bg)] p-3 text-[var(--demo-text-color)] shadow-[0px_0.75px_4.95px_var(--demo-popover-shadow)] dark:border-[var(--demo-popover-border)] dark:bg-[var(--demo-popover-bg)] dark:text-[var(--demo-text-color)]"
                @open-auto-focus.prevent
              >
                <div @mousedown.prevent @touchstart.prevent>
                  <DemoSamplePrompts />
                </div>
              </PopoverContent>
            </Popover>
          </template>
          <textarea
            v-if="!isSttPreset"
            id="prompt-input"
            aria-label="Prompt"
            ref="textareaRef"
            class="resize-none w-full h-48 px-4 pb-16 bg-background/50 rounded-md outline-none border border-border focus-visible:ring-[1px] focus-visible:ring-primary"
            :class="{
              [`pt-${checkedRagDocuments.length > 0 && canAttachDocuments && promptStore.getCurrentMode() === 'chat' ? 8 : 3}`]: true,
              'opacity-50 cursor-not-allowed text-transparent placeholder-transparent':
                !isPromptModifiable,
              'border-primary bg-primary/10': isOverDropZone,
            }"
            :placeholder="getTextAreaPlaceholder()"
            @focus="isTextareaFocused = true"
            @blur="isTextareaFocused = false"
            v-model="prompt"
            :disabled="isTextAreaDisabled"
            @keydown="fastGenerate"
          ></textarea>

          <!-- STT preset: record from the mic or upload an audio file to transcribe.
               No text prompt — the transcript is appended as a chat turn. -->
          <div
            v-else
            class="flex h-48 w-full flex-col items-center justify-center gap-4 rounded-md border border-border bg-background/50 px-4 pb-16 pt-3"
          >
            <p v-if="!sttAvailable" class="text-sm text-amber-500">
              <template v-if="productModeStore.isNvidiaModeSelected">
                Install the standalone Whisper backend from Settings → Installation Management, or
                set an external transcription endpoint in this preset's settings, to transcribe
                speech.
              </template>
              <template v-else>
                Install the OpenVINO backend or standalone Whisper backend, or set an external
                transcription endpoint in this preset's settings, to transcribe speech.
              </template>
            </p>
            <template v-else>
              <Button
                id="stt-record-button"
                class="bg-primary hover:bg-primary/80 text-primary-foreground rounded-lg px-4 py-2"
                :disabled="audioRecorder.isTranscribing || preparingStt"
                @click="handleRecordingClick"
              >
                <i
                  v-if="!preparingStt && !audioRecorder.isTranscribing"
                  class="svg-icon w-5 h-5 mr-2"
                  :class="audioRecorder.isRecording ? 'i-record-active' : 'i-record'"
                ></i>
                <span
                  v-else
                  class="svg-icon i-loading w-5 h-5 mr-2 animate-spin inline-block"
                  aria-hidden="true"
                ></span>
                {{
                  preparingStt
                    ? 'Starting speech service…'
                    : audioRecorder.isTranscribing
                      ? 'Transcribing…'
                      : audioRecorder.isRecording
                        ? 'Stop recording'
                        : 'Record'
                }}
              </Button>
              <Label
                htmlFor="stt-file-upload"
                class="cursor-pointer text-sm text-muted-foreground underline hover:text-foreground"
              >
                or upload an audio file
              </Label>
              <input
                type="file"
                id="stt-file-upload"
                class="hidden"
                accept="audio/*"
                @change="handleSttFileUpload"
              />
            </template>
          </div>
          <div class="absolute bottom-14 left-3 flex gap-2">
            <div
              v-for="preview in imagePreview"
              :key="preview.id"
              class="relative max-h-12 max-w-12 mr-2 aspect-square group"
            >
              <img
                :src="preview.url"
                alt="Image Preview"
                class="w-full h-full object-contain border border-dashed border-border rounded-md"
              />
              <button
                @click="removeImage(preview.id)"
                class="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity bg-background rounded-full p-0.5 text-muted-foreground hover:text-destructive"
                title="Remove image"
              >
                <XMarkIcon class="size-4" />
              </button>
            </div>
            <div
              v-for="clip in audioPreview"
              :key="clip.id"
              class="self-center flex items-center gap-1 px-1 py-0.5 text-xs bg-primary/20 border border-primary/30 rounded-md group"
            >
              <MusicalNoteIcon class="size-4 flex-none" />
              <span class="truncate max-w-40" :title="clip.part.filename">{{
                clip.part.filename
              }}</span>
              <button
                @click="removeImage(clip.id)"
                class="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                title="Remove attachment"
              >
                <XMarkIcon class="size-4" />
              </button>
            </div>
            <div
              v-for="(file, index) in agentMode.attachments"
              :key="`${file.name}-${index}`"
              class="self-center flex items-center gap-1 px-1 py-0.5 text-xs bg-primary/20 border border-primary/30 rounded-md group"
            >
              <PaperClipIcon class="size-4 flex-none" />
              <span class="truncate max-w-40" :title="file.name">{{ file.name }}</span>
              <button
                @click="agentMode.removeAttachment(index)"
                class="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
                title="Remove attachment"
              >
                <XMarkIcon class="size-4" />
              </button>
            </div>
            <div
              v-if="shouldShowImageUploadButton"
              class="self-center border border-dashed border-border rounded-md p-1 hover:cursor-pointer origin-bottom-left"
              :class="{ 'border-primary bg-primary/10': isOverDropZone }"
              id="plus-icon"
            >
              <Label htmlFor="file-attachment" @click="handlePlusIconClick">
                <PlusIcon class="size-4 cursor-pointer" />
              </Label>
              <input
                type="file"
                class="hidden"
                id="file-attachment"
                aria-label="Attach image or document"
                :accept="getAcceptedFileTypes()"
                multiple
                @change="handleFileInput"
              />
            </div>
          </div>
          <ModeNavigation class="absolute bottom-4 left-3" />
          <div class="absolute bottom-4 right-3 flex gap-2">
            <Button
              id="camera-button"
              class="bg-muted hover:bg-muted/80 text-foreground rounded-lg px-3 py-1.5"
              variant="secondary"
              v-if="promptStore.getCurrentMode() === 'chat'"
              @click="handleCameraClick"
              title="Capture image from camera"
            >
              <CameraIcon class="w-5 h-5" />
            </Button>
            <Button
              id="microphone-button"
              class="bg-muted hover:bg-muted/80 text-foreground rounded-lg px-3 py-1.5"
              variant="secondary"
              v-if="promptStore.getCurrentMode() === 'chat'"
              @click="handleRecordingClick"
              :disabled="
                (!sttAvailable && !audioRecorder.isRecording) ||
                audioRecorder.isTranscribing ||
                preparingStt
              "
              :title="
                preparingStt ? 'Starting speech service…' : sttAvailable ? '' : sttUnavailableHint
              "
            >
              <i
                v-if="!audioRecorder.isTranscribing && !preparingStt"
                class="svg-icon w-5 h-5"
                :class="audioRecorder.isRecording ? 'i-record-active' : 'i-record'"
              ></i>
              <span
                v-else
                class="svg-icon i-loading w-5 h-5 animate-spin inline-block"
                :aria-label="preparingStt ? 'Starting speech service' : 'Transcribing'"
              ></span>
              <div
                v-if="audioRecorder.isRecording"
                class="absolute -top-11 flex gap-1 items-end h-10"
              >
                <div
                  v-for="i in 5"
                  :key="i"
                  class="w-1.5 bg-primary rounded-full transition-all duration-100"
                  :style="{
                    height: `${Math.max(6, (audioRecorder.audioLevel / 100) * 40 * (i / 5))}px`,
                    opacity: audioRecorder.audioLevel > (i - 1) * 20 ? 1 : 0.35,
                  }"
                ></div>
              </div>
            </Button>
            <Button
              id="advanced-settings-button"
              class="px-3 py-1.5 bg-muted hover:bg-muted/80 text-foreground rounded-lg text-sm font-normal"
              @click="handleAdvancedSettingsClick"
            >
              {{ mapModeToLabel(promptStore.getCurrentMode()) }} Settings
            </Button>
            <!-- Send / stop / loading cluster — hidden for the STT preset, which
                 submits via its own record/upload controls. -->
            <template v-if="!isSttPreset">
              <Button
                v-if="readyForNewSubmit"
                @click="handleSubmitPromptClick"
                id="send-button"
                aria-label="Send"
                class="px-3 py-1.5 bg-primary hover:bg-primary/80 rounded-lg text-sm min-w-[44px]"
              >
                →
              </Button>
              <Button
                v-else-if="!isStopping"
                @click="handleCancelClick"
                aria-label="Stop generating"
                aria-busy="true"
                class="px-3 py-1.5 bg-red-600 hover:bg-red-500 rounded-lg text-sm min-w-[44px] flex items-center justify-center"
              >
                <i class="svg-icon w-4 h-4 i-stop"></i>
              </Button>
              <Button
                v-else
                disabled
                aria-label="Stopping"
                aria-busy="true"
                class="px-3 py-1.5 bg-red-400 cursor-not-allowed rounded-lg text-sm min-w-[44px] flex items-center justify-center"
              >
                <i class="svg-icon w-4 h-4 i-loading"></i>
              </Button>
            </template>
          </div>
        </div>
      </div>
    </div>

    <!-- Camera Capture Dialog -->
    <div
      v-if="dialogStore.cameraDialogVisible"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
    >
      <div class="bg-background rounded-lg p-6 w-full max-w-lg mx-4 shadow-xl">
        <h2 class="text-lg font-semibold mb-4">Capture Image</h2>
        <CameraCapture @capture="dialogStore.handleCameraCapture" />
        <div class="mt-4 flex justify-end">
          <Button variant="outline" @click="dialogStore.closeCameraDialog()">Close</Button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { getCurrentInstance, ref, computed, watch } from 'vue'
import type { FileUIPart } from 'ai'
import {
  mapModeToLabel,
  downscaleImageTo1MP,
  fileToDataUri,
  fitReferenceDataUri,
  imageUrlToDataUri,
  saveAudioToMediaInput,
  saveImageToMediaInput,
} from '@/lib/utils.ts'
import { referencePixelBudget } from '@/lib/referenceImageFit'
import { useAudioRecorder } from '@/assets/js/store/audioRecorder'
import {
  pendingVoiceTurn,
  preparingStt,
  readyTranscriptionForInput,
  transcriptionAvailable,
  type SttReadyResult,
} from '@/assets/js/speech/speechIO'
import { usePromptStore } from '@/assets/js/store/promptArea'
import {
  useImageGenerationPresets,
  type ImageMediaItem,
} from '@/assets/js/store/imageGenerationPresets.ts'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useConversations } from '@/assets/js/store/conversations'
import { useActivities } from '@/assets/js/store/activities'
import { useErrors } from '@/assets/js/store/errors'
import { useTextInference } from '@/assets/js/store/textInference'
import type { IndexedDocument, ValidFileExtension } from '@/types/rag'
import { useI18N } from '@/assets/js/store/i18n'
import { usePresets, type ChatPreset } from '@/assets/js/store/presets'
import { useProductMode } from '@/assets/js/store/productMode'
import { PlusIcon, PaperClipIcon, MusicalNoteIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { CameraIcon } from '@heroicons/vue/24/solid'
import { Label } from '@/components/ui/label'
import { useDropZone, useEventListener } from '@vueuse/core'
import * as toast from '@/assets/js/toast'
import Button from '@/components/ui/button/Button.vue'
import PromptStatusBar from '@/components/PromptStatusBar.vue'
import { useDialogStore } from '@/assets/js/store/dialogs'
import CameraCapture from '@/components/CameraCapture.vue'
import { useDemoMode } from '@/assets/js/store/demoMode'
import DemoSamplePrompts from '@/components/DemoSamplePrompts.vue'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import ModeNavigation from '@/components/ModeNavigation.vue'

const instance = getCurrentInstance()
const audioRecorder = useAudioRecorder()
const languages = instance?.appContext.config.globalProperties.languages
const i18nState = useI18N().state
const prompt = ref('')
const promptStore = usePromptStore()
const imageGeneration = useImageGenerationPresets()
const processingDebounceTimer = ref<number | null>(null)
const openAiCompatibleChat = useOpenAiCompatibleChat()
const agentMode = useAgentMode()
const textInference = useTextInference()
const conversations = useConversations()
const activities = useActivities()
const errors = useErrors()
const textareaRef = ref<HTMLTextAreaElement>()
const isTextareaFocused = ref(false)
const presetsStore = usePresets()
const dialogStore = useDialogStore()

// Modes that run on chat-type presets and stream their turns into a conversation
// view. They share the prompt box's text handling (free-form text, cleared after a
// turn), unlike the ComfyUI modes which keep the prompt around.
const chatLikeModes: ModeType[] = ['chat', 'agent', 'audio']
const isChatLikeMode = computed(() => chatLikeModes.includes(promptStore.getCurrentMode()))

const demoMode = useDemoMode()
const productModeStore = useProductMode()

// Get active chat preset
const activeChatPreset = computed(() => {
  const preset = presetsStore.activePresetWithVariant
  if (preset?.type === 'chat') return preset as ChatPreset
  return null
})

// Direct Speech-to-Text preset: the prompt box becomes a record/upload surface.
const isSttPreset = computed(() => activeChatPreset.value?.sttPreset === true)

// Whether voice input is usable: OpenVINO Whisper (non-NVIDIA), the standalone
// Whisper backend, or a configured external transcription endpoint (any mode).
// Replaces the old global STT toggle. The in-chat mic is rendered regardless and
// disabled when this is false — it used to be `v-if`'d away, so anything that
// flipped availability (e.g. a transient backend start failure) made the button
// vanish with no explanation and no way back inside the session.
const sttAvailable = computed(() => transcriptionAvailable())

const sttUnavailableHint = computed(() =>
  productModeStore.isNvidiaModeSelected
    ? 'Install the standalone Whisper backend (or set an external transcription endpoint) to use voice input'
    : 'Install the OpenVINO backend or standalone Whisper backend, or set an external transcription endpoint, to use voice input',
)

// Handle an uploaded audio file in the STT preset: transcribe it into a chat turn.
async function handleSttFileUpload(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (!file) return
  await openAiCompatibleChat.transcribeDirect(file, {
    conversationKey: conversations.activeKey,
    sourceLabel: `🎤 ${file.name}`,
  })
}

audioRecorder.registerRecordingCompleteHandler(async (wavBlob) => {
  if (!isSttPreset.value) return
  await openAiCompatibleChat.transcribeDirect(wavBlob, {
    conversationKey: conversations.activeKey,
    sourceLabel: '🎤 Recording',
  })
})

audioRecorder.registerTranscriptionCallback((text) => {
  if (isSttPreset.value) return
  prompt.value = text
  // Mark this as a voice-originated turn so the reply can be auto-spoken.
  pendingVoiceTurn.value = true
})

// Check if images can be attached (vision model selected)
const canAttachImages = computed(() => {
  // The Audio mode's presets take text or recorded audio, never an image.
  if (promptStore.getCurrentMode() === 'audio') return false
  if (promptStore.getCurrentMode() !== 'chat') return true // Allow for image modes
  return textInference.modelSupportsVision
})

// Check if documents can be attached (RAG enabled)
const canAttachDocuments = computed(() => {
  if (promptStore.getCurrentMode() !== 'chat') return false
  return activeChatPreset.value?.enableRAG === true
})

// Audio is an attachment for `transcribeAudio` to read, not something the chat
// backend can be sent, so the control only offers it when that tool is there.
const canAttachAudio = computed(
  () => promptStore.getCurrentMode() === 'chat' && openAiCompatibleChat.canTranscribeAttachments,
)

// Should show image upload button (conditional for ComfyUI presets)
const shouldShowImageUploadButton = computed(() => {
  const mode = promptStore.getCurrentMode()
  const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']

  // For ComfyUI modes, only show if preset has required image input
  if (comfyUiModes.includes(mode)) {
    if (!imageGeneration.activePreset) return false
    if (imageGeneration.activePreset.type !== 'comfy') return false

    const hasRequiredImageInput = imageGeneration.comfyInputs.some(
      (input) => input.type === 'image' && input.optional !== true,
    )

    return hasRequiredImageInput
  }

  // Agent mode saves attachments into the workspace instead of sending them to
  // the model, so any file is useful and no vision model is required.
  if (mode === 'agent') return true

  // For chat mode, use existing logic (vision model + RAG documents + audio)
  return canAttachImages.value || canAttachDocuments.value || canAttachAudio.value
})

// Get checked RAG documents for display
const checkedRagDocuments = computed(() => {
  return textInference.ragList.filter((doc) => doc.isChecked)
})

// Get icon class for RAG document type
function getRagIconClass(type: ValidFileExtension): string {
  switch (type) {
    case 'doc':
    case 'docx':
      return 'i-word'
    case 'md':
      return 'i-md'
    case 'pdf':
      return 'i-pdf'
    case 'txt':
    default:
      return 'i-txt'
  }
}

const emits = defineEmits<{
  (e: 'autoHideFooter'): void
  (e: 'openSettings'): void
}>()

const attachmentPreview = computed(() =>
  openAiCompatibleChat.fileInput.map((part, id) => ({ id, url: part.url, part })),
)

const imagePreview = computed(() =>
  attachmentPreview.value.filter((item) => !item.part.mediaType?.startsWith('audio/')),
)

const audioPreview = computed(() =>
  attachmentPreview.value.filter((item) => item.part.mediaType?.startsWith('audio/')),
)

function removeImage(index: number) {
  openAiCompatibleChat.fileInput = openAiCompatibleChat.fileInput.filter((_, i) => i !== index)
}

// Busy state is unified through the activity sink: in addition to the streaming /
// generation flags, any active chat activity for the current conversation (backend
// prep, RAG search, tool resolution, thinking) keeps the prompt area in its busy
// state so the send/stop control matches the in-turn activity indicator.
const isProcessing = computed(
  () =>
    openAiCompatibleChat.processing ||
    imageGeneration.processing ||
    // Model/backend load runs before the chat stream starts (so `processing` is
    // still false); keep the busy state up for it too, so the send/stop control
    // is the single, complete signal for "is the app working on this turn".
    textInference.isPreparingBackend ||
    agentMode.processing ||
    activities.chatActivity(conversations.activeKey) !== null,
)

const isStopping = computed(() => imageGeneration.stopping)

const readyForNewSubmit = computed(() => !promptStore.promptSubmitted && !isProcessing.value)

const isFirstPrompt = computed(() => {
  const mode = promptStore.getCurrentMode()

  const isFirstChatPrompt =
    mode === 'chat' &&
    !openAiCompatibleChat.messages?.length &&
    !openAiCompatibleChat.processing &&
    !textInference.isPreparingBackend

  const isFirstImageGenPrompt =
    mode === 'imageGen' &&
    (!imageGeneration.selectedGeneratedImageId ||
      imageGeneration.selectedGeneratedImageId === 'new') &&
    !imageGeneration.processing

  // Demo preloads an edit input via copyImageAsInputForMode, which sets selectedEditedImageId.
  // Still show the sample until a real workflow output exists (those omit fromImageGen; inputs set it true).
  const hasCompletedImageEditOutput = imageGeneration.generatedImages.some(
    (item) =>
      item.mode === 'imageEdit' &&
      item.state === 'done' &&
      item.type === 'image' &&
      item.fromImageGen !== true,
  )
  const isFirstImageEditPrompt =
    mode === 'imageEdit' &&
    !imageGeneration.processing &&
    (!imageGeneration.selectedEditedImageId || (demoMode.enabled && !hasCompletedImageEditOutput))

  return isFirstChatPrompt || isFirstImageGenPrompt || isFirstImageEditPrompt
})

// Check if prompt is modifiable for ComfyUI presets
const isPromptModifiable = computed(() => {
  const mode = promptStore.getCurrentMode()
  // In the chat-like modes (chat, audio) the prompt is always modifiable
  if (chatLikeModes.includes(mode)) return true

  // For image/video modes, check if there's an active ComfyUI preset
  if (mode === 'imageGen' || mode === 'imageEdit' || mode === 'video') {
    // If there's an active preset, check if prompt is modifiable
    if (imageGeneration.activePreset) {
      return imageGeneration.isModifiable('prompt')
    }
    // If no active preset, allow prompt input (fallback behavior)
    return true
  }

  return true
})

const isTextAreaDisabled = computed(() => {
  return !readyForNewSubmit.value || !isPromptModifiable.value
})

const contextError = computed(() => openAiCompatibleChat.error)

watch(isProcessing, (newValue, oldValue) => {
  if (processingDebounceTimer.value !== null) {
    clearTimeout(processingDebounceTimer.value)
    processingDebounceTimer.value = null
  }

  if (oldValue === true && newValue === false) {
    // Only clear the prompt in the chat-like modes (chat, agent, audio); persist it
    // for the ComfyUI modes (imageGen, imageEdit, video)
    if (isChatLikeMode.value) {
      processingDebounceTimer.value = window.setTimeout(() => {
        prompt.value = ''
        promptStore.promptSubmitted = false
        processingDebounceTimer.value = null
      }, 1000)
    } else {
      // For ComfyUI modes, just reset the submitted flag but keep the prompt
      promptStore.promptSubmitted = false
    }
  }
})

// Sync prompt from store to textarea when switching to ComfyUI modes
watch(
  () => promptStore.getCurrentMode(),
  (newMode) => {
    const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']
    if (comfyUiModes.includes(newMode)) {
      // When switching to ComfyUI modes, sync the store prompt to the textarea
      prompt.value = imageGeneration.prompt || ''
    }
  },
)

// Keep textarea in sync with imageGeneration.prompt for ComfyUI modes
watch(
  () => imageGeneration.prompt,
  (newPrompt) => {
    const currentMode = promptStore.getCurrentMode()
    const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']
    if (comfyUiModes.includes(currentMode)) {
      // Only sync if the prompt actually changed to avoid unnecessary updates
      if (prompt.value !== newPrompt) {
        prompt.value = newPrompt || ''
      }
    }
  },
)

// Accept programmatically injected prompt text (e.g. from demo sample prompts)
watch(
  () => promptStore.injectedPromptText,
  (text) => {
    if (text !== null) {
      prompt.value = text
      promptStore.injectedPromptText = null
    }
  },
)

function getTextAreaPlaceholder() {
  // The TTS preset runs in 'chat' mode but takes literal text to speak, not a
  // chat prompt — so it needs its own placeholder.
  const active = presetsStore.activePreset
  if (active?.type === 'chat' && active.ttsPreset) {
    return languages?.COM_PROMPT_TTS || ''
  }
  // Agent presets differ in what they ask for: Game Agent wants a game, the plain
  // agent a task in the chosen folder.
  if (active?.type === 'chat' && active.agentPreset) {
    return active.agentWorkspace === 'games'
      ? 'Describe the game you want to play — the agent will build it...'
      : 'Describe a task for the agent to perform in the selected folder...'
  }
  switch (promptStore.getCurrentMode()) {
    case 'chat':
      return languages?.COM_PROMPT_CHAT || ''
    case 'agent':
      return 'Describe a task for the agent to perform in the selected folder...'
    case 'audio':
      return languages?.COM_PROMPT_TTS || ''
    case 'imageGen':
      return languages?.COM_PROMPT_IMAGE_GEN || ''
    case 'imageEdit':
      return languages?.COM_PROMPT_IMAGE_EDIT || ''
    case 'video':
      return languages?.COM_PROMPT_VIDEO || ''
    default:
      return languages?.COM_PROMPT_CHAT || ''
  }
}

function handleSubmitPromptClick() {
  const needsPrompt = isChatLikeMode.value || imageGeneration.requiresUserPrompt
  if (needsPrompt && !prompt.value.trim()) {
    toast.error(languages?.COM_ERROR_NO_MESSAGE || 'Please enter a message before sending.')
    return
  }
  emits('autoHideFooter')
  promptStore.submitPrompt(prompt.value)
}

function handleCancelClick() {
  promptStore.cancelProcessing()
}

async function handleRecordingClick() {
  if (demoMode.triggerFirstTimeHelp('microphone-button')) return
  // Stop must stay reachable even if speech-to-text was disabled mid-recording.
  if (audioRecorder.isRecording) {
    audioRecorder.stopRecording()
    return
  }
  if (!sttAvailable.value) return
  // Ready the selected engine before recording (may prompt a model download on
  // first use), so transcription is ready when the clip is captured. The External
  // engine needs nothing started.
  try {
    // Ready the selected engine before recording (may prompt a model download on
    // first use), so transcription is ready when the clip is captured.
    const ready: SttReadyResult = await readyTranscriptionForInput()
    // This click was spent on the model download popup. Do not roll straight into
    // a recording once the download finishes: the user is not talking yet, so the
    // mic would capture whatever comes next and transcribe it as gibberish. Let
    // them press the mic again now that the model is in place.
    if (ready.downloadPrompted) {
      toast.success('Speech To Text model downloaded. Press the microphone to start recording.')
      return
    }
  } catch (error) {
    errors.report(error, {
      category: 'inference',
      code: 'inference/stt-unavailable',
      userMessage: error instanceof Error ? error.message : 'Speech To Text is unavailable',
    })
    return
  }
  await audioRecorder.startRecording(isSttPreset.value ? { manualStopOnly: true } : undefined)
}

// Recorder failures are surfaced here rather than at the call site: transcription
// runs in the recorder's MediaRecorder.onstop handler, long after
// handleRecordingClick returned, so a failed transcription previously left no
// trace in the UI at all.
watch(
  () => audioRecorder.error,
  (message) => {
    if (!message) return
    errors.report(message, {
      category: 'inference',
      code: 'inference/audio-record-failed',
      userMessage: message,
    })
  },
)

function handleCameraClick() {
  if (demoMode.triggerFirstTimeHelp('camera-button')) return
  dialogStore.showCameraDialog(async (file: File) => {
    await handleImageFiles([file])
  })
}

function handleAdvancedSettingsClick() {
  if (demoMode.triggerFirstTimeHelp('advanced-settings-button')) return
  emits('openSettings')
}

function fastGenerate(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    handleSubmitPromptClick()
  }
}

// Valid document extensions for RAG
const validDocumentExtensions = ['txt', 'doc', 'docx', 'md', 'pdf'] as const

// Check if a file is an image
function isImageFile(file: File): boolean {
  return file.type.startsWith('image/')
}

const AUDIO_ATTACHMENT_UNAVAILABLE =
  'Audio attachments need the "Transcribe audio" tool. Enable it for this preset to attach a clip.'

function isAudioFile(file: File): boolean {
  return file.type.startsWith('audio/')
}

// Check if a file is a valid document
function isDocumentFile(file: File): boolean {
  const ext = file.name.split('.').pop()?.toLowerCase()
  return ext ? validDocumentExtensions.includes(ext as ValidFileExtension) : false
}

// Get accepted file types based on preset capabilities
function getAcceptedFileTypes(): string {
  const mode = promptStore.getCurrentMode()
  const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']

  // For ComfyUI modes with image input, only accept images
  if (comfyUiModes.includes(mode) && shouldShowImageUploadButton.value) {
    return 'image/*'
  }

  // For chat mode, check capabilities
  if (mode === 'chat') {
    const types: string[] = []
    if (canAttachImages.value) types.push('image/*')
    if (canAttachAudio.value) types.push('audio/*')
    if (canAttachDocuments.value) types.push('.txt,.doc,.docx,.md,.pdf')

    return types.join(',') || 'none'
  }

  // An agent's attachment is just a file in its workspace — art, data, a
  // reference document — so nothing is off-limits.
  if (mode === 'agent') return ''

  // For other modes, default to none
  return 'none'
}

// Handle ComfyUI-specific image uploads
async function handleComfyUIImageUpload(imageFiles: File[]) {
  if (imageFiles.length === 0) return

  // Take only the first image
  const imageFile = imageFiles[0]
  const imageUrl = URL.createObjectURL(imageFile)

  try {
    const dataUri = await imageUrlToDataUri(imageUrl)
    const preset = presetsStore.activePresetWithVariant
    const workflow = preset?.type === 'comfy' ? preset.comfyUiApiWorkflow : undefined
    const fittedUri = await fitReferenceDataUri(
      dataUri,
      workflow,
      referencePixelBudget(preset?.category, imageGeneration.width, imageGeneration.height),
    )
    const aipgMediaUrl = await saveImageToMediaInput(fittedUri)

    const firstImageInput = imageGeneration.comfyInputs.find((input) => input.type === 'image')

    if (firstImageInput) {
      const historyMode: WorkflowModeType =
        promptStore.getCurrentMode() === 'video' ? 'video' : 'imageEdit'
      firstImageInput.current.value = aipgMediaUrl

      const imageItem: ImageMediaItem = {
        createdAt: Date.now(),
        id: crypto.randomUUID(),
        type: 'image',
        mode: historyMode,
        state: 'done',
        imageUrl: aipgMediaUrl,
        sourceImageUrl: imageUrl,
        fromImageGen: true,
        settings: {},
      }

      imageGeneration.addGalleryItem(imageItem)
      if (historyMode === 'video') imageGeneration.selectedVideoId = imageItem.id
      else imageGeneration.selectedEditedImageId = imageItem.id

      if (historyMode === 'imageEdit' && promptStore.getCurrentMode() !== 'imageEdit') {
        promptStore.setCurrentMode('imageEdit')
      }
    }
  } catch (error) {
    errors.report(error, {
      category: 'inference',
      code: 'inference/image-load-failed',
      userMessage: 'Failed to load image',
    })
  } finally {
    URL.revokeObjectURL(imageUrl)
  }
}

async function handleChatImageUpload(imageFiles: File[]) {
  const filesToProcess = await Promise.all(
    imageFiles.map((file) => downscaleImageTo1MP(file)),
  ).catch((error) => {
    console.error('Error downscaling images:', error)
    return imageFiles
  })

  const parts: FileUIPart[] = []
  for (const file of filesToProcess) {
    const objectUrl = URL.createObjectURL(file)
    try {
      const dataUri = await imageUrlToDataUri(objectUrl)
      const aipgUrl = await saveImageToMediaInput(dataUri)
      parts.push({ type: 'file', mediaType: file.type, url: aipgUrl, filename: file.name })
    } finally {
      URL.revokeObjectURL(objectUrl)
    }
  }
  openAiCompatibleChat.fileInput = parts
}

// Audio rides along with whatever images are already attached — the clip is for
// `transcribeAudio`, which reads it off the turn rather than from the prompt.
async function handleChatAudioUpload(audioFiles: File[]) {
  const parts: FileUIPart[] = []
  for (const file of audioFiles) {
    try {
      const url = await saveAudioToMediaInput(await fileToDataUri(file))
      parts.push({ type: 'file', mediaType: file.type, url, filename: file.name })
    } catch (error) {
      errors.report(error, {
        category: 'inference',
        code: 'inference/audio-attach-failed',
        userMessage: `Could not attach ${file.name}.`,
      })
    }
  }
  if (parts.length > 0) {
    openAiCompatibleChat.fileInput = [...openAiCompatibleChat.fileInput, ...parts]
  }
}

// Handle image files: ComfyUI upload vs chat/other → fileInput as aipg-media
async function handleImageFiles(imageFiles: File[]) {
  if (imageFiles.length === 0) return

  if (promptStore.getCurrentMode() === 'chat') {
    await handleChatImageUpload(imageFiles)
  } else {
    await handleComfyUIImageUpload(imageFiles)
  }
}

function handlePlusIconClick(event: MouseEvent) {
  if (demoMode.triggerFirstTimeHelp('plus-icon')) {
    event.preventDefault()
    return
  }
  if (demoMode.enabled) {
    event.preventDefault()
    toast.show('Clicking this feature is disabled during demo.')
    return
  }
  // Let the Label's default behavior open the file dialog
}

// Handle file input change
async function handleFileInput(event: Event) {
  const target = event.target as HTMLInputElement
  if (!target.files || target.files.length === 0) return

  const files = Array.from(target.files)
  if (promptStore.getCurrentMode() === 'agent') {
    await agentMode.attachFiles(files)
    target.value = ''
    return
  }

  const imageFiles: File[] = []
  const audioFiles: File[] = []
  const documentFiles: File[] = []

  // Separate images from audio from documents
  for (const file of files) {
    if (isImageFile(file)) {
      imageFiles.push(file)
    } else if (isAudioFile(file) && promptStore.getCurrentMode() === 'chat') {
      audioFiles.push(file)
    } else if (isDocumentFile(file) && promptStore.getCurrentMode() === 'chat') {
      documentFiles.push(file)
    }
  }

  // Validate image attachments
  if (imageFiles.length > 0 && !canAttachImages.value) {
    toast.error(
      'The current model does not support image attachments. Select a vision model to attach images.',
    )
    imageFiles.length = 0
  }

  if (audioFiles.length > 0 && !canAttachAudio.value) {
    toast.error(AUDIO_ATTACHMENT_UNAVAILABLE)
    audioFiles.length = 0
  }

  // Validate document attachments
  if (documentFiles.length > 0 && !canAttachDocuments.value) {
    toast.error(
      'Document attachments are not enabled for this preset. Use the "Assistant" preset or similar.',
    )
    documentFiles.length = 0
  }

  // Handle images
  if (imageFiles.length > 0) {
    await handleImageFiles(imageFiles)
  }

  if (audioFiles.length > 0) {
    await handleChatAudioUpload(audioFiles)
  }

  // Handle documents (add to RAG)
  if (documentFiles.length > 0) {
    await addDocumentsToRagList(documentFiles)
  }

  // Reset input
  target.value = ''
}

// Add documents to RAG list
async function addDocumentsToRagList(files: File[]) {
  for (const file of files) {
    try {
      const filePath = window.electronAPI.getFilePath(file)
      const name = filePath.split(/(\\|\/)/g).pop()
      const ext = name?.split('.').pop()?.toLowerCase() as ValidFileExtension | undefined

      if (!name || !ext || !validDocumentExtensions.includes(ext)) {
        toast.error(i18nState.RAG_UPLOAD_TYPE_ERROR)
        continue
      }

      // Check if document already exists in RAG list (by filepath)
      const existingDoc = textInference.ragList.find((doc) => doc.filepath === filePath)

      if (existingDoc) {
        // Document already exists - just enable it if it's disabled
        if (!existingDoc.isChecked) {
          textInference.updateFileCheckStatus(existingDoc.hash, true)
        }
        // If already checked, do nothing
        continue
      }

      // Document doesn't exist - add it
      const newDocument: IndexedDocument = {
        filename: name,
        filepath: filePath,
        type: ext,
        splitDB: [],
        hash: '',
        isChecked: true,
      }

      await textInference.addDocumentToRagList(newDocument)
    } catch (error) {
      errors.report(error, {
        category: 'inference',
        code: 'inference/rag-add-failed',
        userMessage: i18nState.RAG_UPLOAD_TYPE_ERROR,
      })
    }
  }
}

// Handle drag and drop
async function onDrop(files: File[] | null) {
  if (!files || files.length === 0) return

  if (promptStore.getCurrentMode() === 'agent') {
    await agentMode.attachFiles(files)
    return
  }

  const imageFiles: File[] = []
  const audioFiles: File[] = []
  const documentFiles: File[] = []

  // Separate images from audio from documents
  for (const file of files) {
    if (isImageFile(file)) {
      imageFiles.push(file)
    } else if (isAudioFile(file) && promptStore.getCurrentMode() === 'chat') {
      audioFiles.push(file)
    } else if (isDocumentFile(file) && promptStore.getCurrentMode() === 'chat') {
      documentFiles.push(file)
    }
  }

  // For ComfyUI modes with image input, only accept images
  const comfyUiModes: ModeType[] = ['imageGen', 'imageEdit', 'video']
  if (comfyUiModes.includes(promptStore.getCurrentMode()) && shouldShowImageUploadButton.value) {
    // Filter out non-image files
    if (documentFiles.length > 0) {
      toast.error('Only images can be uploaded in this mode.')
    }
    // Handle images through ComfyUI handler
    if (imageFiles.length > 0) {
      await handleImageFiles(imageFiles)
    }
    return
  }

  // Validate image attachments
  if (imageFiles.length > 0 && !canAttachImages.value) {
    toast.error(
      'The current model does not support image attachments. Select a vision model to attach images.',
    )
    imageFiles.length = 0
  }

  if (audioFiles.length > 0 && !canAttachAudio.value) {
    toast.error(AUDIO_ATTACHMENT_UNAVAILABLE)
    audioFiles.length = 0
  }

  // Validate document attachments
  if (documentFiles.length > 0 && !canAttachDocuments.value) {
    toast.error(
      'Document attachments are not enabled for this preset. Use the "Assistant" preset or similar.',
    )
    documentFiles.length = 0
  }

  // Handle images
  if (imageFiles.length > 0) {
    await handleImageFiles(imageFiles)
  }

  if (audioFiles.length > 0) {
    await handleChatAudioUpload(audioFiles)
  }

  // Handle documents
  if (documentFiles.length > 0) {
    // Validate document extensions
    const filePaths = documentFiles.map((file) => window.electronAPI.getFilePath(file))
    const fileExtensions = filePaths.map(
      (filePath) => filePath.split('.').pop()?.toLowerCase() ?? '',
    )

    if (
      fileExtensions.some((ext) => !validDocumentExtensions.includes(ext as ValidFileExtension))
    ) {
      toast.error(i18nState.RAG_UPLOAD_TYPE_ERROR)
      return
    }

    addDocumentsToRagList(documentFiles)
  }
}

// Set up drag and drop zone
const { isOverDropZone } = useDropZone(textareaRef, {
  onDrop,
  multiple: true,
  preventDefaultForUnhandled: false,
})

// Handle clipboard paste for images
function handlePaste(event: ClipboardEvent) {
  // Block image paste when vision is not supported
  if (!canAttachImages.value) return

  const items = event.clipboardData?.items
  if (!items) return

  const imageFiles: File[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) imageFiles.push(file)
    }
  }

  if (imageFiles.length > 0) {
    event.preventDefault() // Prevent default paste behavior for images
    handleImageFiles(imageFiles)
  }
}

// Attach paste event listener to textarea
useEventListener(textareaRef, 'paste', handlePaste)
</script>
