<script lang="ts" setup>
import { nextTick, ref } from 'vue'
import {
  backendToService,
  useTextInference,
  type LlmBackend,
  type LlmModel,
} from '@/assets/js/store/textInference'
import { CLOUD_DEFAULT_MODEL, useCloudMode } from '@/assets/js/store/cloudMode'
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
import { modelMeetsPresetRequirements } from '@/lib/presetModelFilter'
import { sortFavoritesFirst } from '@/assets/js/models/favorites'
import { llamaCppFitTarget, useVramFitLevels } from '@/lib/useLlamaCppVramFit'
import { useI18N } from '@/assets/js/store/i18n'

type Requirements = {
  vision: boolean
  toolCalling: boolean
  reasoning: boolean
  coding: boolean
  agentic: boolean
  npuSupport: boolean
  txt2TxtOnly: boolean
  largeMoeOnly: boolean
  advancedMode: boolean
}

// Without props the picker edits the shared selection under the active preset's
// requirements; with `modelValue` it is a controlled picker for its own backend
// (an Agent Maker task) and never touches the shared selection.
const props = defineProps<{
  backend?: LlmBackend
  modelValue?: string
  /** Cloud provider to list models of, instead of the shared selected provider. */
  providerId?: string
  requirements?: Partial<Requirements>
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const textInference = useTextInference()
const presetsStore = usePresets()
const backendServices = useBackendServices()
const cloudMode = useCloudMode()

const controlled = computed(() => props.modelValue !== undefined)
const backend = computed<LlmBackend>(() => props.backend ?? textInference.backend)

const backendModels = computed<LlmModel[]>(() => {
  if (backend.value !== 'cloud' || !props.providerId) {
    return textInference.llmModels.filter((m) => m.type === backend.value)
  }
  const provider = cloudMode.providers.find((p) => p.id === props.providerId)
  const ids = provider?.models.length ? provider.models : [CLOUD_DEFAULT_MODEL]
  return ids.map((name) => {
    const caps = provider?.modelCapabilities?.[name]
    return {
      name,
      type: 'cloud',
      active: false,
      downloaded: true,
      supportsToolCalling: caps?.supportsToolCalling,
      supportsVision: caps?.supportsVision,
      supportsReasoning: caps?.supportsReasoning,
      maxContextSize: caps?.contextLength,
    }
  })
})

const value = computed(() =>
  controlled.value
    ? (props.modelValue ?? '')
    : (backendModels.value.find((m) => m.active)?.name ?? ''),
)

function select(name: string) {
  if (controlled.value) emit('update:modelValue', name)
  else textInference.selectModel(backend.value, name)
}

// Get current model's capabilities
const currentModel = computed(() => backendModels.value.find((m) => m.name === value.value))

const runningOnOpenvinoNpu = computed(
  () =>
    !!backendServices.info
      .find((s) => s.serviceName === backendToService[backend.value])
      ?.devices.find((d) => d.selected)
      ?.id.includes('NPU'),
)

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
  const activePreset = presetsStore.activePresetWithVariant
  const fromPreset: Requirements = {
    vision: activePreset?.type === 'chat' && activePreset.requiresVision === true,
    toolCalling: activePreset?.type === 'chat' && activePreset.requiresToolCalling === true,
    reasoning: activePreset?.type === 'chat' && activePreset.requiresReasoning === true,
    coding: activePreset?.type === 'chat' && activePreset.requiresCoding === true,
    agentic: activePreset?.type === 'chat' && activePreset.requiresAgentic === true,
    npuSupport: activePreset?.type === 'chat' && activePreset.requiresNpuSupport === true,
    txt2TxtOnly: activePreset?.type === 'chat' && activePreset.filterTxt2TxtOnly === true,
    largeMoeOnly: activePreset?.type === 'chat' && activePreset.filterLargeMoeOnly === true,
    advancedMode: activePreset?.type === 'chat' && activePreset.advancedMode === true,
  }
  const requirements: Requirements = props.requirements
    ? {
        vision: false,
        toolCalling: false,
        reasoning: false,
        coding: false,
        agentic: false,
        npuSupport: false,
        txt2TxtOnly: false,
        largeMoeOnly: false,
        advancedMode: false,
        ...props.requirements,
      }
    : fromPreset
  const searchLc = search.value.trim().toLowerCase()

  return sortFavoritesFirst(backendModels.value)
    .filter((m) => {
      // Case-insensitive substring search on the visible label (last path segment).
      // Applied to every backend, including cloud.
      if (!searchLc) return true
      const label = (m.name.split('/').at(-1) ?? m.name).toLowerCase()
      return label.includes(searchLc)
    })
    .filter((m) => {
      // Cloud Mode models come from a remote provider's /v1/models list and
      // carry no capability metadata (vision/tool-calling/etc. are all unknown,
      // hence false). The preset-requirement and custom-model filters below would
      // therefore drop every cloud model, leaving the picker empty. Remote models
      // can't be filtered on unknown capabilities, so always surface them.
      if (backend.value === 'cloud') return true
      // Models too big for a normal GPU stay off every other preset until a Phison
      // SSD is detected. `largeMoe` is a separate list: the aiDAPTIV preset below
      // still includes the medium MoE models, which a normal preset may show.
      if (m.requiresPhison && !backendServices.phisonSsdDetected) return false
      // Restrict to large Mixture-of-Experts models only (e.g. the Phison aiDAPTIV+ preset)
      if (requirements.largeMoeOnly && !m.largeMoe) return false
      // Preset gates are AND. Coding keeps models that can write a whole game;
      // agentic keeps models that can sustain a multi-step tool turn.
      if (
        !modelMeetsPresetRequirements(m, {
          vision: requirements.vision,
          toolCalling: requirements.toolCalling,
          reasoning: requirements.reasoning,
          coding: requirements.coding,
          agentic: requirements.agentic,
          npuSupport: requirements.npuSupport,
        })
      ) {
        return false
      }
      if (backend.value === 'openVINO') {
        if (runningOnOpenvinoNpu.value && !m.npuSupport) return false
        if (!runningOnOpenvinoNpu.value && m.npuSupport) return false
      }
      // Filter out vision and reasoning models for txt2txt only presets
      if (requirements.txt2TxtOnly && (m.supportsVision || m.supportsReasoning)) return false
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
      // Only show predefined models unless advancedMode is enabled OR
      // custom model explicitly matches the preset's requirements
      if (!requirements.advancedMode && !m.isPredefined) {
        // For custom models, only show if they match at least one requirement
        const hasMatchingRequirement =
          (requirements.vision && m.supportsVision) ||
          (requirements.toolCalling && m.supportsToolCalling) ||
          (requirements.reasoning && m.supportsReasoning) ||
          (requirements.coding && m.supportsCoding) ||
          (requirements.agentic && m.supportsAgentic) ||
          (requirements.npuSupport && m.npuSupport)

        // Show basic models in txt2txt presets only if they don't have vision/reasoning
        const qualifiesForTxt2Txt =
          requirements.txt2TxtOnly &&
          !m.supportsVision &&
          !m.supportsReasoning &&
          !m.supportsToolCalling &&
          !m.npuSupport

        if (!hasMatchingRequirement && !qualifiesForTxt2Txt) return false
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
  const currentValue = value.value
  const availableItems = items.value

  // If current selection is not in the filtered list, select the first available
  if (availableItems.length > 0 && !availableItems.some((item) => item.value === currentValue)) {
    select(availableItems[0].value)
  }
})
</script>

<template>
  <DropdownMenu v-model:open="open">
    <DropdownMenuTrigger as-child>
      <button class="w-full">
        <div
          class="w-full h-[30px] rounded-md bg-card border border-border text-foreground px-3 flex items-center gap-2 overflow-hidden"
        >
          <div
            class="w-2 h-2 rounded-full shrink-0"
            :class="selectedItem.active ? 'bg-primary' : 'bg-muted-foreground'"
          ></div>
          <span class="text-xs flex-1 min-w-0 text-left truncate">
            {{ selectedItem.label }}
          </span>
          <div class="flex items-center gap-1 shrink-0">
            <ModelVramFit v-if="!controlled" />
            <ModelVramFit
              v-else-if="currentModel && backend === 'llamaCPP'"
              :model="llamaCppFitTarget(currentModel)"
            />
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
