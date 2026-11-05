<template>
  <div class="absolute bottom-14 left-3 flex gap-2">
    <slot name="previews" />
    <div
      v-if="showAttach"
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
        :accept="acceptedFileTypes"
        multiple
        @change="(e: Event) => emit('attach', e)"
      />
    </div>
  </div>
  <div
    id="mode-buttons"
    class="absolute bottom-4 left-3 flex gap-2"
    @pointerleave="schedulePickerClose"
  >
    <Popover
      v-for="mode in modes"
      :key="mode"
      :open="openPickerMode === mode"
      @update:open="(val: boolean) => onPickerOpenChange(mode, val)"
    >
      <!-- Shared anchor pinned to the left edge of the button row, so every
           mode's picker opens from the same point (using the full width) -->
      <PopoverAnchor as-child>
        <span aria-hidden="true" class="pointer-events-none absolute left-0 top-0 bottom-0 w-0" />
      </PopoverAnchor>
      <PopoverTrigger as-child>
        <Button
          :variant="buttonModeFor(promptStore.getCurrentMode()) === mode ? 'default' : 'secondary'"
          :id="'mode-button-' + mode"
          @pointerenter="(e: PointerEvent) => onPickerPointerEnter(mode, e)"
          @pointerdown="onPickerPointerDown"
          @focus="(e: FocusEvent) => onPickerFocus(mode, e)"
          @blur="schedulePickerClose()"
          @click="handleModeClick(mode)"
        >
          {{ mapModeToLabel(mode) }}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        :side-offset="8"
        class="z-[40010] w-auto max-w-[80vw] rounded-lg border border-border bg-card p-2 shadow-xl"
        @open-auto-focus.prevent
        @close-auto-focus.prevent
      >
        <!-- Hover handlers live on this inner div rather than <PopoverContent>:
             that wrapper's root is a Teleport (PopoverPortal), which drops attrs. -->
        <div
          data-aipg-help="preset-selector"
          class="flex gap-2 overflow-x-auto max-w-[76vw] pb-1"
          @pointerenter="cancelPickerClose"
          @pointerleave="schedulePickerClose"
        >
          <TooltipProvider :delay-duration="200">
            <Tooltip v-for="preset in presetsForMode(mode)" :key="preset.name">
              <TooltipTrigger as-child>
                <button
                  type="button"
                  :aria-label="oemBranding.presetLabel(preset.name)"
                  :aria-pressed="presetsStore.activePresetName === preset.name"
                  :aria-disabled="!gateOf(preset).enabled"
                  :data-aipg-preset-name="preset.name"
                  class="relative flex-none w-16 h-16 rounded-md overflow-hidden border-2 transition-all duration-150"
                  :class="[
                    presetsStore.activePresetName === preset.name
                      ? 'border-primary ring-2 ring-primary'
                      : 'border-transparent',
                    gateOf(preset).enabled
                      ? 'hover:border-primary'
                      : 'opacity-40 grayscale cursor-not-allowed',
                  ]"
                  @click="selectPresetFromPicker(mode, preset)"
                >
                  <img
                    v-if="preset.image"
                    :src="preset.image"
                    :alt="oemBranding.presetLabel(preset.name)"
                    class="absolute inset-0 w-full h-full object-cover"
                  />
                  <div class="absolute bottom-0 w-full bg-background/70 px-0.5 py-0.5">
                    <span
                      class="block text-foreground text-[9px] leading-tight font-medium text-center truncate"
                    >
                      {{ oemBranding.presetLabel(preset.name) }}
                    </span>
                  </div>
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" class="z-[40011] max-w-[260px]">
                <p class="font-semibold">{{ oemBranding.presetLabel(preset.name) }}</p>
                <p v-if="preset.description" class="mt-1 text-primary-foreground/80">
                  {{ preset.description }}
                </p>
                <p v-if="!gateOf(preset).enabled" class="mt-1 text-amber-400 text-xs">
                  {{ gateOf(preset).reason }}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <p
            v-if="presetsForMode(mode).length === 0"
            class="text-xs text-muted-foreground px-2 py-4 whitespace-nowrap"
          >
            No presets available
          </p>
        </div>
      </PopoverContent>
    </Popover>
  </div>
  <div class="absolute bottom-4 right-3 flex gap-2">
    <Button
      id="camera-button"
      class="bg-muted hover:bg-muted/80 text-foreground rounded-lg px-3 py-1.5"
      variant="secondary"
      v-if="promptStore.getCurrentMode() === 'chat'"
      :disabled="downloading"
      @click="emit('camera')"
      title="Capture image from camera"
    >
      <AcerCameraIcon class="w-5 h-5" />
    </Button>
    <Button
      id="microphone-button"
      class="bg-muted hover:bg-muted/80 text-foreground rounded-lg px-3 py-1.5"
      variant="secondary"
      v-if="promptStore.getCurrentMode() === 'chat'"
      @click="emit('record')"
      :disabled="
        (!sttAvailable && !audioRecorder.isRecording) ||
        audioRecorder.isTranscribing ||
        preparingStt ||
        downloading
      "
      :title="preparingStt ? 'Starting speech service…' : sttAvailable ? '' : sttUnavailableHint"
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
      <div v-if="audioRecorder.isRecording" class="absolute -top-11 flex gap-1 items-end h-10">
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
    <!-- Send / stop / loading cluster — hidden for the STT preset, which
         submits via its own record/upload controls. -->
    <template v-if="showSend">
      <TooltipProvider v-if="readyForNewSubmit" :delay-duration="200">
        <Tooltip v-if="canRunSteps">
          <TooltipTrigger as-child>
            <Button
              @click="emit('runSteps')"
              :aria-label="languages?.AGENT_STEPS_RUN"
              :disabled="settingsBlocked || isSlashCommand"
              class="px-3 py-1.5 bg-primary hover:bg-primary/80 rounded-lg text-sm min-w-[44px] flex items-center justify-center"
            >
              <PlayIcon class="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{{ languages?.AGENT_STEPS_RUN_TIP }}</TooltipContent>
        </Tooltip>
        <Tooltip :disabled="!canRunSteps">
          <TooltipTrigger as-child>
            <Button
              @click="emit('send')"
              id="send-button"
              aria-label="Send"
              :disabled="settingsBlocked"
              class="px-3 py-1.5 bg-primary hover:bg-primary/80 rounded-lg text-sm min-w-[44px]"
            >
              →
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{{ languages?.AGENT_STEPS_SEND_TIP }}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Button
        v-else-if="!isStopping"
        @click="emit('cancel')"
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
</template>

<script setup lang="ts">
import { getCurrentInstance, ref, nextTick, watch } from 'vue'
import { PlusIcon } from '@heroicons/vue/24/outline'
import { PlayIcon } from '@heroicons/vue/24/solid'
import { useAudioRecorder } from '@/assets/js/store/audioRecorder'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { usePresets, type Preset } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { useSessionChat } from '@/assets/js/store/sessionChat'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useDemoMode, type DemoButtonId } from '@/assets/js/store/demoMode'
import { preparingStt } from '@/assets/js/speech/speechIO'
import AcerCameraIcon from '@/components/AcerCameraIcon.vue'
import Button from '@/components/ui/button/Button.vue'
import { Label } from '@/components/ui/label'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { mapModeToLabel } from '@/lib/utils.ts'
import { MODE_TO_CATEGORIES, MODE_TO_PRESET_TYPE, buttonModeFor } from '@/lib/presetModes'
import { presetGate, type PresetGate } from '@/lib/presetGate'
import * as toast from '@/assets/js/toast'

const props = defineProps<{
  modes: ModeType[]
  phisonUsable: boolean
  showAttach: boolean
  acceptedFileTypes: string
  isOverDropZone: boolean
  downloading: boolean
  sttAvailable: boolean
  sttUnavailableHint: string
  showSend: boolean
  readyForNewSubmit: boolean
  canRunSteps: boolean
  settingsBlocked: boolean
  isSlashCommand: boolean
  isStopping: boolean
}>()

const emit = defineEmits<{
  (e: 'attach', event: Event): void
  (e: 'camera'): void
  (e: 'record'): void
  (e: 'send'): void
  (e: 'runSteps'): void
  (e: 'cancel'): void
}>()

const instance = getCurrentInstance()
const languages = instance?.appContext.config.globalProperties.languages
const audioRecorder = useAudioRecorder()
const promptStore = usePromptStore()
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const oemBranding = useOemBranding()
const conversations = useConversations()
const sessionChat = useSessionChat()
const homeAgent = useHomeAgent()
const demoMode = useDemoMode()

function gateOf(preset: Preset): PresetGate {
  return presetGate(preset, {
    phisonUsable: props.phisonUsable,
    homeAgentEnabled: homeAgent.masterEnabled,
    homeAgentAvailable: homeAgent.isAvailable,
  })
}

function presetsForMode(mode: ModeType): Preset[] {
  return presetsStore.getPresetsByCategories(MODE_TO_CATEGORIES[mode], MODE_TO_PRESET_TYPE[mode])
}

// Quick preset picker: which mode's picker popover is currently open (null = none).
const openPickerMode = ref<ModeType | null>(null)

// The picker opens on hover (mouse) with a small delay, and closes shortly after the
// pointer leaves the button row / picker — the grace delay bridges the offset gap
// between the two so the menu doesn't flicker on the way up.
const PICKER_OPEN_DELAY = 80
const PICKER_CLOSE_DELAY = 150
let pickerOpenTimer: number | null = null
let pickerCloseTimer: number | null = null
// Touch/pen users get no hover, so for them the trigger click may still open the picker.
let lastPickerPointerType = 'mouse'

function clearPickerTimers() {
  if (pickerOpenTimer !== null) {
    window.clearTimeout(pickerOpenTimer)
    pickerOpenTimer = null
  }
  if (pickerCloseTimer !== null) {
    window.clearTimeout(pickerCloseTimer)
    pickerCloseTimer = null
  }
}

function openPicker(mode: ModeType) {
  clearPickerTimers()
  // Suppressed only while a demo tour is on screen, so it doesn't collide with its popover.
  if (demoMode.tourOpen) return
  if (openPickerMode.value === mode) return
  pickerOpenTimer = window.setTimeout(() => {
    pickerOpenTimer = null
    openPickerMode.value = mode
  }, PICKER_OPEN_DELAY)
}

function schedulePickerClose() {
  clearPickerTimers()
  pickerCloseTimer = window.setTimeout(() => {
    pickerCloseTimer = null
    openPickerMode.value = null
  }, PICKER_CLOSE_DELAY)
}

function cancelPickerClose() {
  clearPickerTimers()
}

function closePicker() {
  clearPickerTimers()
  openPickerMode.value = null
}

function onPickerPointerEnter(mode: ModeType, event: PointerEvent) {
  if (event.pointerType === 'mouse') openPicker(mode)
}

function onPickerFocus(mode: ModeType, event: FocusEvent) {
  // Open for keyboard focus only: clicking the button focuses it too, and that
  // click is a mode switch, not a request to open the picker.
  const target = event.target as HTMLElement | null
  if (target?.matches(':focus-visible')) openPicker(mode)
}

function onPickerPointerDown(event: PointerEvent) {
  lastPickerPointerType = event.pointerType
}

function onPickerOpenChange(mode: ModeType, open: boolean) {
  // Reka asks to open on trigger click; hover is the only opener for mouse users,
  // so only close requests (outside click / Escape) are honored there. Touch/pen
  // taps get no hover, so their click still opens the picker as before.
  if (!open) {
    closePicker()
    return
  }
  if (lastPickerPointerType !== 'mouse' && !demoMode.tourOpen) openPickerMode.value = mode
}

async function selectPresetFromPicker(mode: ModeType, preset: Preset) {
  // Greyed-out presets (feature off / not installed) aren't selectable — explain why.
  const gate = gateOf(preset)
  if (!gate.enabled) {
    toast.warning(gate.reason ?? 'This preset is not available yet.')
    return
  }

  closePicker() // Selecting a preset closes the picker.

  if (presetSwitching.isSwitching) {
    toast.warning('Please wait for current preset change to complete')
    return
  }
  // No-op if it's already the active preset for this mode.
  if (
    preset.name === presetsStore.activePresetName &&
    buttonModeFor(promptStore.getCurrentMode()) === mode
  ) {
    return
  }

  // Hovering only opened the picker, so selecting the preset performs the mode
  // switch too (skipPresetSwitch: we pick the preset ourselves right after).
  if (!promptStore.setCurrentMode(mode, { skipPresetSwitch: true })) return

  // Route the active conversation alongside the preset, mirroring SettingsChatInferencing:
  // Home Agent jumps to its remote thread; leaving a Home Agent thread for another
  // preset spawns a fresh main conversation so we don't write into Home Agent state.
  const switchingToHomeAgent = preset.name === HOME_AGENT_CHAT_PRESET_NAME
  const onHomeAgentThread = conversations.getThreadKind(conversations.activeKey) === 'homeAgent'

  // The mode is left to the switch: an agent preset from the chat list moves the app
  // to Agent Mode, which the button above cannot know.
  const result = await presetSwitching.switchPreset(preset.name)
  if (result.success) {
    if (switchingToHomeAgent) {
      conversations.activeKey = homeAgent.ensureActiveRemoteConversation()
    } else if (onHomeAgentThread) {
      sessionChat.returnToSessionChat()
    }
    toast.success(`Switched to ${oemBranding.presetLabel(preset.name)}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}

watch(
  () => demoMode.tourOpen,
  (open) => {
    if (open) closePicker()
  },
)

function handleModeClick(mode: ModeType) {
  const buttonId = `mode-button-${mode}` as DemoButtonId
  // Clicking switches the mode only; the quick preset picker opens on hover, and
  // closing it here keeps the menu from being dragged along by the layout shift
  // a mode switch can cause.
  closePicker()
  promptStore.setCurrentMode(mode)
  void nextTick(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        demoMode.triggerFirstTimeHelp(buttonId)
      })
    })
  })
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
</script>
