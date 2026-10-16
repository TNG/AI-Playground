<script lang="ts" setup>
import { nextTick, ref } from 'vue'
import { type LlmBackend, useTextInference } from '@/assets/js/store/textInference'
import { usePresets } from '@/assets/js/store/presets'
import { useBackendServices } from '@/assets/js/store/backendServices'
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDownIcon, MagnifyingGlassIcon, StarIcon } from '@heroicons/vue/24/solid'
import ModelCapabilities from './ModelCapabilities.vue'
import ModelVramFit from './ModelVramFit.vue'
import VramChipIcon from './VramChipIcon.vue'
import CapabilityIcons, { type ExtraFilter } from './CapabilityIcons.vue'
import { modelPassesCapabilityFilters, type CapabilityKey } from '@/assets/js/capabilities'
import { llmModelChoices, type ModelChoicePreset } from '@/lib/llmModelChoices'
import { llamaCppFitTarget, useVramFitLevels } from '@/lib/useLlamaCppVramFit'
import { useI18N } from '@/assets/js/store/i18n'

// Each prop left out falls back to the chat store; `bound` ties the pick to `modelValue`
// (emitted, never selected in the store). `autoSelect` replaces a pick the list no longer offers.
const props = defineProps<{
  bound?: boolean
  backend?: LlmBackend
  preset?: ModelChoicePreset | null
  onNpu?: boolean
  modelValue?: string
  autoSelect?: boolean
}>()
const emit = defineEmits<{ 'update:modelValue': [modelName: string] }>()

const textInference = useTextInference()
const presetsStore = usePresets()
const backendServices = useBackendServices()

const backend = computed(() => props.backend ?? textInference.backend)

const currentModel = computed(() =>
  props.bound
    ? textInference.llmModels.find((m) => m.type === backend.value && m.name === props.modelValue)
    : textInference.llmModels.find((m) => m.active && m.type === backend.value),
)

const value = computed(() => (props.bound ? props.modelValue : currentModel.value?.name) ?? '')

// The trigger's fit chip judges the selected model; unbound it follows the store's active one.
const boundFitTarget = computed(() => llamaCppFitTarget(currentModel.value))

function select(modelName: string) {
  if (props.bound) emit('update:modelValue', modelName)
  else textInference.selectModel(backend.value, modelName)
}

// User-driven picker controls: a case-insensitive substring search and a set of
// capability filters toggled from the icon row. These narrow the list on top of
// any preset-level requirements (Home Agent tool-calling, Phison large-MoE, …).
const open = ref(false)
const search = ref('')
const activeFilters = ref<Set<CapabilityKey>>(new Set())
const fitsOnly = ref(false)
const searchInput = ref<HTMLInputElement | null>(null)

const i18nState = useI18N().state
const { levelOf } = useVramFitLevels()

// Only llama.cpp models get a verdict, so on any other backend the toggle would
// be a control that cannot change the list.
const fitFilterAvailable = computed(() => backend.value === 'llamaCPP')

const fitFilters = computed<ExtraFilter[]>(() =>
  fitFilterAvailable.value
    ? [
        {
          key: 'fits',
          label: i18nState.VRAM_FIT_FILTER,
          icon: VramChipIcon,
          active: fitsOnly.value,
          hint: fitsOnly.value ? i18nState.VRAM_FIT_FILTER_ON : i18nState.VRAM_FIT_FILTER_OFF,
        },
      ]
    : [],
)

function toggleFilter(key: CapabilityKey) {
  const next = new Set(activeFilters.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  activeFilters.value = next
}

// reka-ui focuses the first menu item when the content opens; prevent that and
// focus the search field instead so the user can type immediately.
function onOpenAutoFocus(e: Event) {
  e.preventDefault()
  nextTick(() => searchInput.value?.focus())
}

const items = computed(() => {
  const searchLc = search.value.trim().toLowerCase()
  const choices = llmModelChoices(textInference.llmModels, {
    backend: backend.value,
    preset: props.preset !== undefined ? props.preset : presetsStore.activePresetWithVariant,
    onNpu: props.onNpu ?? textInference.runningOnOpenvinoNpu,
    phisonSsdDetected: backendServices.phisonSsdDetected,
  })

  return choices
    .filter((m) => {
      // Case-insensitive substring search on the visible label (last path segment).
      if (!searchLc) return true
      const label = (m.name.split('/').at(-1) ?? m.name).toLowerCase()
      return label.includes(searchLc)
    })
    .filter((m) => {
      // Cloud models carry no capability metadata, so the user filters would drop them all.
      if (backend.value === 'cloud') return true
      // User-selected capability filters (AND). Deselected capabilities don't filter.
      if (!modelPassesCapabilityFilters(m, activeFilters.value)) return false
      // Size filter: green and yellow stay; red goes, and so does a model whose
      // header came back empty — an unknown size is not a model to offer. A
      // header still in flight has no verdict at all and is left alone, or the
      // list would empty itself while it loads.
      if (fitsOnly.value) {
        const level = levelOf(llamaCppFitTarget(m))
        if (level === 'over' || level === 'unknown') return false
      }
      return true
    })
    .map((item) => ({
      label: item.name.split('/').at(-1) ?? item.name,
      value: item.name,
      fitTarget: llamaCppFitTarget(item),
      active: item.downloaded,
      supportsToolCalling: item.supportsToolCalling,
      supportsVision: item.supportsVision,
      supportsReasoning: item.supportsReasoning,
      supportsAgentic: item.supportsAgentic,
      maxContextSize: item.maxContextSize,
      npuSupport: item.npuSupport,
      favorite: item.favorite === true,
    }))
})

const selectedItem = computed(() => {
  return (
    items.value.find((item) => item.value === value.value) || {
      label: 'Select...',
      value: '',
      active: false,
    }
  )
})

// Auto-select first model when current selection is not in the filtered list
watchEffect(() => {
  if (!props.autoSelect) return
  const currentValue = value.value
  const availableItems = items.value

  // A sent Agent session keeps its stored model; an unusable one blocks Send instead.
  if (!props.bound && textInference.sessionSettingsPinned) return
  // If current selection is not in the filtered list, select the first available
  if (availableItems.length > 0 && !availableItems.some((item) => item.value === currentValue)) {
    select(availableItems[0].value)
  }
})
</script>

<template>
  <DropdownMenu v-model:open="open">
    <DropdownMenuTrigger as-child>
      <button class="group w-full">
        <div
          class="w-full h-[30px] rounded-md bg-card border border-border text-foreground px-3 flex items-center gap-2 overflow-hidden group-disabled:opacity-50 group-disabled:cursor-not-allowed"
        >
          <div
            class="w-2 h-2 rounded-full shrink-0"
            :class="selectedItem.active ? 'bg-primary' : 'bg-muted-foreground'"
          ></div>
          <span class="text-xs flex-1 min-w-0 text-left truncate">
            {{ selectedItem.label }}
          </span>
          <div class="flex items-center gap-1 shrink-0">
            <ModelVramFit
              v-if="props.bound && boundFitTarget"
              :key="boundFitTarget.name"
              :model="boundFitTarget"
            />
            <ModelVramFit v-else-if="!props.bound" />
            <ModelCapabilities v-if="currentModel" :model="currentModel" />
            <ChevronDownIcon class="size-4 text-muted-foreground"></ChevronDownIcon>
          </div>
        </div>
      </button>
    </DropdownMenuTrigger>
    <!-- Anchored to the trigger's end (its right edge sits at the settings panel's
         right padding) so the wider menu grows left into the panel instead of
         overflowing off-screen. max-w keeps it inside the viewport on narrow windows. -->
    <DropdownMenuContent
      :align="'end'"
      class="w-[28rem] max-w-[calc(100vw-2rem)] rounded-md p-[3px] border border-border bg-card z-[100]"
      @open-auto-focus="onOpenAutoFocus"
    >
      <!-- Search + capability filters on one row. Kept outside the scrolling list
           so they stay visible, and shielded from the menu's typeahead/arrow-key
           navigation via keydown/pointerdown .stop. The search field flexes to fill
           the row, so when a capability (e.g. NPU) is hidden the layout rescales. -->
      <div class="px-2 py-2 flex items-center gap-2" @pointerdown.stop>
        <div
          class="flex flex-1 min-w-0 items-center gap-2 rounded-md border border-border bg-background px-2"
        >
          <MagnifyingGlassIcon class="size-3.5 text-muted-foreground shrink-0" />
          <input
            ref="searchInput"
            v-model="search"
            type="text"
            placeholder="Search models…"
            class="w-full bg-transparent py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none"
            @keydown.stop
          />
        </div>
        <div class="shrink-0">
          <CapabilityIcons
            mode="filter"
            :active-keys="activeFilters"
            :extras="fitFilters"
            icon-size="size-4"
            @toggle="toggleFilter"
            @toggle-extra="fitsOnly = !fitsOnly"
          />
        </div>
      </div>
      <DropdownMenuSeparator class="bg-border" />
      <div class="py-1 max-h-[188px] overflow-y-auto">
        <div v-if="items.length === 0" class="px-4 py-2 text-xs text-muted-foreground">
          No models match your search and filters.
        </div>
        <DropdownMenuItem
          v-for="item in items"
          :key="item.value"
          @click="() => select(item.value)"
          class="text-sm px-4 py-1 flex items-center text-left hover:bg-muted text-foreground group"
        >
          <div class="flex items-center flex-1 min-w-0">
            <div
              class="w-2 h-2 rounded-full mr-2 shrink-0"
              :class="item.active ? 'bg-primary' : 'bg-muted-foreground'"
            ></div>
            <StarIcon v-if="item.favorite" class="size-3 mr-1.5 shrink-0 text-primary" />
            <span class="flex-1 truncate">{{ item.label }}</span>
            <div class="flex items-center gap-1 ml-2 shrink-0">
              <ModelVramFit :model="item.fitTarget" />
              <CapabilityIcons
                :model="{
                  supportsVision: item.supportsVision,
                  supportsToolCalling: item.supportsToolCalling,
                  supportsReasoning: item.supportsReasoning,
                  supportsAgentic: item.supportsAgentic,
                }"
                icon-size="size-3.5"
              />
            </div>
          </div>
        </DropdownMenuItem>
      </div>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
