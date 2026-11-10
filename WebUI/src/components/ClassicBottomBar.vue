<template>
  <div class="absolute bottom-14 left-3 flex gap-2">
    <PromptAttachmentPreviews />
    <PromptAttachButton
      v-if="showAttach"
      :accepted-file-types="acceptedFileTypes"
      :is-over-drop-zone="isOverDropZone"
      @attach="(e: Event) => emit('attach', e)"
    />
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
        class="z-[40010] w-auto max-w-[80vw] max-h-[var(--reka-popover-content-available-height)] overflow-y-auto rounded-lg border border-border bg-card p-2 shadow-xl"
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
          @focusin="cancelPickerClose"
        >
          <TooltipProvider :delay-duration="200">
            <Tooltip v-for="preset in presetsForMode(mode)" :key="preset.name">
              <TooltipTrigger as-child>
                <button
                  type="button"
                  :aria-label="oemBranding.presetLabel(preset.name)"
                  :aria-pressed="pickedPresetName === preset.name"
                  :aria-disabled="!gateOf(preset).enabled"
                  :data-aipg-preset-name="preset.name"
                  class="relative flex-none w-16 h-16 rounded-md overflow-hidden border-2 transition-all duration-150"
                  :class="[
                    pickedPresetName === preset.name
                      ? 'border-primary ring-2 ring-primary'
                      : 'border-transparent',
                    gateOf(preset).enabled
                      ? 'hover:border-primary'
                      : 'opacity-40 grayscale cursor-not-allowed',
                  ]"
                  @click="selectPresetFromPicker(preset)"
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
                <p v-if="gateOf(preset).reason" class="mt-1 text-amber-400 text-xs">
                  {{ i18nState[gateOf(preset).reason!] }}
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
          <TooltipProvider
            v-if="mode === buttonModeFor('agent') && agents.length > 0"
            :delay-duration="200"
          >
            <div
              role="group"
              :aria-label="i18nState.AGENT_LIBRARY_LIST"
              class="flex min-w-0 flex-col gap-1 border-l border-border pl-2"
            >
              <Input
                v-if="agentView.filterable"
                v-model="agentQuery"
                type="search"
                :placeholder="i18nState.AGENT_LIBRARY_FILTER"
                :aria-label="i18nState.AGENT_LIBRARY_FILTER"
                class="h-7 w-48 px-2 text-xs"
                @focus="agentFilterFocused = true"
                @blur="agentFilterFocused = false"
                @keydown.enter.prevent="pickFirstMatch"
              />
              <div class="flex min-w-0 gap-2 overflow-x-auto pb-1">
                <p
                  v-if="agentView.agents.length === 0"
                  role="status"
                  class="text-xs text-muted-foreground px-2 py-4 whitespace-nowrap"
                >
                  {{ i18nState.AGENT_LIBRARY_FILTER_EMPTY }}
                </p>
                <Tooltip v-for="agent in agentView.agents" :key="agent.id">
                  <TooltipTrigger as-child>
                    <button
                      type="button"
                      :aria-label="agent.name"
                      :aria-pressed="pickedAgentId === agent.id"
                      class="relative flex-none w-16 h-16 rounded-md overflow-hidden border-2 bg-muted transition-all duration-150 hover:border-primary"
                      :class="
                        pickedAgentId === agent.id
                          ? 'border-primary ring-2 ring-primary'
                          : 'border-transparent'
                      "
                      @click="selectAgentFromPicker(agent.id)"
                    >
                      <img
                        v-if="agent.image"
                        :src="agent.image"
                        :alt="agent.name"
                        class="absolute inset-0 w-full h-full object-cover"
                      />
                      <div class="absolute bottom-0 w-full bg-background/70 px-0.5 py-0.5">
                        <span
                          class="block text-foreground text-[9px] leading-tight font-medium text-center truncate"
                        >
                          {{ agent.name }}
                        </span>
                      </div>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" class="z-[40011] max-w-[260px]">
                    <p class="font-semibold">{{ agent.name }}</p>
                    <p v-if="agent.description" class="mt-1 text-primary-foreground/80">
                      {{ agent.description }}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
          </TooltipProvider>
          <div v-if="mode === buttonModeFor('agent')" class="flex flex-none flex-col gap-1">
            <Button
              variant="secondary"
              size="sm"
              class="h-7"
              @click="openLibrary(() => manageAgents())"
            >
              <Squares2X2Icon class="size-4" />
              {{ i18nState.AGENT_LIBRARY_MANAGE }}
            </Button>
          </div>
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
    <PromptCaptureButtons
      :downloading="downloading"
      :stt-available="sttAvailable"
      :stt-unavailable-hint="sttUnavailableHint"
      @camera="emit('camera')"
      @record="emit('record')"
    />
    <PromptSendButtons
      :show-send="showSend"
      :ready-for-new-submit="readyForNewSubmit"
      :picked-agent-name="pickedAgentName"
      :agent-composer="agentComposer"
      :settings-blocked="settingsBlocked"
      :is-slash-command="isSlashCommand"
      :is-stopping="isStopping"
      @send="emit('send')"
      @run-agent="emit('runAgent')"
      @cancel="emit('cancel')"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, nextTick, watch } from 'vue'
import { Squares2X2Icon } from '@heroicons/vue/24/outline'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { usePresets, type Preset } from '@/assets/js/store/presets'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useI18N } from '@/assets/js/store/i18n'
import { useDemoMode, type DemoButtonId } from '@/assets/js/store/demoMode'
import Button from '@/components/ui/button/Button.vue'
import { Input } from '@/components/ui/input'
import PromptAttachButton from '@/components/PromptAttachButton.vue'
import PromptAttachmentPreviews from '@/components/PromptAttachmentPreviews.vue'
import PromptCaptureButtons from '@/components/PromptCaptureButtons.vue'
import PromptSendButtons from '@/components/PromptSendButtons.vue'
import type { AgentComposerState } from '@/lib/agentComposer'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { mapModeToLabel } from '@/lib/utils.ts'
import { MODE_TO_CATEGORIES, MODE_TO_PRESET_TYPE, buttonModeFor } from '@/lib/presetModes'
import { usePromptBarPresetSwitch } from '@/lib/usePromptBarPresetSwitch'
import { useAgentLibraryEntry } from '@/lib/useAgentLibraryEntry'
import { usePromptBarAgentPick } from '@/lib/usePromptBarAgentPick'
import { agentList, pickableAgents } from '@/lib/promptBarModel'

defineProps<{
  modes: ModeType[]
  showAttach: boolean
  acceptedFileTypes: string
  isOverDropZone: boolean
  downloading: boolean
  sttAvailable: boolean
  sttUnavailableHint: string
  showSend: boolean
  readyForNewSubmit: boolean
  /** Set while an Agent is picked: ▶ runs it, Send follows up on its latest run. */
  pickedAgentName?: string
  agentComposer?: AgentComposerState
  settingsBlocked: boolean
  isSlashCommand: boolean
  isStopping: boolean
}>()

const emit = defineEmits<{
  (e: 'attach', event: Event): void
  (e: 'camera'): void
  (e: 'record'): void
  (e: 'send'): void
  (e: 'runAgent'): void
  (e: 'cancel'): void
}>()

const promptStore = usePromptStore()
const presetsStore = usePresets()
const oemBranding = useOemBranding()
const i18nState = useI18N().state
const { gateOf } = usePromptBarPresetSwitch()
const agentPick = usePromptBarAgentPick()
const { pickedAgentId, pickedPresetName } = agentPick
const demoMode = useDemoMode()
const { manageAgents } = useAgentLibraryEntry()

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
  // Typing in the Agent filter must not lose the picker to a stray pointer move.
  if (agentFilterFocused.value) return
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

// Hovering only opened the picker, so selecting a preset performs the mode switch too.
async function openLibrary(open: () => unknown) {
  closePicker()
  await open()
}

async function selectPresetFromPicker(preset: Preset) {
  if (gateOf(preset).enabled) closePicker()
  await agentPick.pickPreset(preset.name)
}

async function selectAgentFromPicker(agentId: string) {
  closePicker()
  await agentPick.pickAgent(agentId)
}

const agents = computed(() => pickableAgents(agentPick.agents.value))
const agentQuery = ref('')
const agentFilterFocused = ref(false)
const agentView = computed(() => agentList(agents.value, agentQuery.value))

async function pickFirstMatch() {
  const first = agentView.value.agents[0]
  if (first) await selectAgentFromPicker(first.id)
}

watch(openPickerMode, (mode) => {
  if (mode === null) {
    agentQuery.value = ''
    agentFilterFocused.value = false
  }
})

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
</script>
