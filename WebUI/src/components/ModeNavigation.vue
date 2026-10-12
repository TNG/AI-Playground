<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useConversations, HOME_AGENT_CHAT_PRESET_NAME } from '@/assets/js/store/conversations'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { usePresets, type ChatPreset, type Preset } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useDemoMode, type DemoButtonId } from '@/assets/js/store/demoMode'
import Button from '@/components/ui/button/Button.vue'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { MODE_TO_CATEGORIES, MODE_TO_PRESET_TYPE, buttonModeFor } from '@/lib/presetModes'
import { mapModeToLabel } from '@/lib/utils'
import * as toast from '@/assets/js/toast'

// The mode buttons and their hover preset pickers: the app's navigation between
// modes and presets, shared by the prompt bar and views that have none (Agent Maker).

const promptStore = usePromptStore()
const oemBranding = useOemBranding()
const conversations = useConversations()
const homeAgent = useHomeAgent()
const backendServices = useBackendServices()
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const demoMode = useDemoMode()

// Some chat presets are gated on a feature that the user can enable/install but
// that may currently be off. They stay visible in the picker but greyed-out and
// non-selectable (with a reason), unlike presets that are entirely unavailable on
// this system — those are filtered out upstream (e.g. aiDAPTIV™/Phison without the
// SSD).
const phisonUsable = computed(
  () =>
    backendServices.phisonSsdDetected &&
    (backendServices.info.find((s) => s.serviceName === 'llamacpp-backend')
      ?.llamaCppPhisonArtifactReady ??
      false) &&
    backendServices.llamaCppBuildVariant === 'ssd-offload',
)

/** Whether a picker preset is currently selectable, plus why not when disabled. */
function presetGate(preset: Preset): { enabled: boolean; reason?: string } {
  if (preset.type === 'chat' && (preset as ChatPreset).requiresPhison) {
    return phisonUsable.value
      ? { enabled: true }
      : { enabled: false, reason: 'Install and activate the aiDAPTIV™ build to use this preset.' }
  }
  if (preset.name === HOME_AGENT_CHAT_PRESET_NAME) {
    if (!homeAgent.masterEnabled) {
      return { enabled: false, reason: 'Enable the Home Agent in settings to use this preset.' }
    }
    if (!homeAgent.isAvailable) {
      return { enabled: false, reason: 'The Home Agent backend is not installed or running yet.' }
    }
    return { enabled: true }
  }
  return { enabled: true }
}

// Quick preset picker: which mode's picker popover is currently open (null = none).
const openPickerMode = ref<ModeType | null>(null)

function presetsForMode(mode: ModeType): Preset[] {
  return presetsStore.getPresetsByCategories(MODE_TO_CATEGORIES[mode], MODE_TO_PRESET_TYPE[mode])
}

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
  // Suppressed during the guided demo so it doesn't collide with the demo help popover.
  if (demoMode.enabled) return
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
  if (lastPickerPointerType !== 'mouse' && !demoMode.enabled) openPickerMode.value = mode
}

async function selectPresetFromPicker(mode: ModeType, preset: Preset) {
  // Greyed-out presets (feature off / not installed) aren't selectable — explain why.
  const gate = presetGate(preset)
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

  // Route the active conversation alongside the preset, mirroring SettingsChat:
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
      conversations.addNewConversation()
    }
    toast.success(`Switched to ${preset.name}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}
const modesWithPresets = computed(() => {
  const modes: ModeType[] = []
  if (presetsStore.chatPresets.length > 0) modes.push('chat')
  if (presetsStore.audioPresets.length > 0) modes.push('audio')
  if (presetsStore.imageGenPresets.length > 0) modes.push('imageGen')
  if (presetsStore.imageEditPresets.length > 0) modes.push('imageEdit')
  if (presetsStore.videoPresets.length > 0) modes.push('video')
  return modes
})

watch([modesWithPresets, () => promptStore.getCurrentMode()], ([modes, currentMode]) => {
  if (modes.length > 0 && currentMode && !modes.includes(buttonModeFor(currentMode))) {
    promptStore.setCurrentMode(modes[0])
  }
})

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

<template>
  <!-- `relative`: the pickers anchor to this row, wherever the caller places it. -->
  <div id="mode-buttons" @pointerleave="schedulePickerClose">
    <div class="relative flex gap-2">
      <Popover
        v-for="mode in modesWithPresets"
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
            :variant="
              buttonModeFor(promptStore.getCurrentMode()) === mode ? 'default' : 'secondary'
            "
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
                    :aria-disabled="!presetGate(preset).enabled"
                    :data-aipg-preset-name="preset.name"
                    class="relative flex-none w-16 h-16 rounded-md overflow-hidden border-2 transition-all duration-150"
                    :class="[
                      presetsStore.activePresetName === preset.name
                        ? 'border-primary ring-2 ring-primary'
                        : 'border-transparent',
                      presetGate(preset).enabled
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
                  <p v-if="!presetGate(preset).enabled" class="mt-1 text-amber-400 text-xs">
                    {{ presetGate(preset).reason }}
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
  </div>
</template>
