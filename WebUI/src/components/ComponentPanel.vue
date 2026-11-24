<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
import SetupWizardRow, { type SetupWizardRowView } from '@/components/SetupWizardRow.vue'
import SetupWizardGroup, { type SetupWizardGroupToggle } from '@/components/SetupWizardGroup.vue'
import type { BackendServiceName } from '@/assets/js/store/backendServices'
import type { PhisonAidaptivRowViewModel } from '@/assets/js/store/setupWizard'

export type ComponentPanelApplyMode = 'draft' | 'live'

export type ComponentPanelModeOption = {
  mode: ProductMode
  experimental: boolean
  titleOne: string
  titleTwo: string
  subtitle: string
  description: string
  supportedHardware: string
}

export type ComponentPanelDeviceOption = {
  key: string
  label: string
  category: DeviceCategory
}

export type ComponentPanelBackendRow = {
  serviceName: BackendServiceName
  view: SetupWizardRowView
}

export type ComponentPanelOptionsRow =
  | ({ kind: 'backend' } & ComponentPanelBackendRow)
  | { kind: 'cloud'; view: SetupWizardRowView }
  | { kind: 'demo'; view: SetupWizardRowView }

export type ComponentPanelToggleIntent = {
  row: ComponentPanelOptionsRow
  enabled: boolean
  applyMode: ComponentPanelApplyMode
}

const props = defineProps<{
  applyMode: ComponentPanelApplyMode
  modeOptions: ComponentPanelModeOption[]
  selectedMode: ProductMode | null
  recommendedMode: ProductMode | null
  deviceOptions: ComponentPanelDeviceOption[]
  selectedDeviceKey: string | null
  overrideDeviceSelection: boolean
  coreRow: ComponentPanelBackendRow | null
  coreDependentRows: ComponentPanelBackendRow[]
  groupRows: ComponentPanelBackendRow[]
  groupToggle: SetupWizardGroupToggle | null
  cloudRow: SetupWizardRowView
  /** Live mode has no Demo Mode row: that setting stays in App Settings. */
  demoModeRow: SetupWizardRowView | null
  ungroupedRows: ComponentPanelBackendRow[]
  phisonRow: PhisonAidaptivRowViewModel | null
  coreServicesOpen: boolean
  /** Shows the Hardware Mode choices but changes nothing — that change is later work. */
  selectionReadOnly?: boolean
}>()

defineSlots<{
  /** The settings menu (gear) for a backend, Cloud Mode or Demo Mode row. */
  options?: (props: { row: ComponentPanelOptionsRow }) => unknown
  /** The settings menu for the Phison aiDAPTIV row. */
  'phison-options'?: () => unknown
}>()

const emit = defineEmits<{
  selectMode: [mode: ProductMode]
  selectDevice: [key: string]
  overrideDevice: [value: boolean]
  saveDevice: [intent: { key: string; override: boolean }]
  groupToggle: [value: boolean]
  toggle: [intent: ComponentPanelToggleIntent]
  repair: [row: ComponentPanelOptionsRow]
  showError: [row: ComponentPanelOptionsRow]
  install: [row: ComponentPanelOptionsRow]
  update: [row: ComponentPanelOptionsRow]
  togglePhison: [value: boolean]
  'update:coreServicesOpen': [value: boolean]
}>()

const languages = useI18N().state

const deviceDialogOpen = ref(false)
const draftDeviceKey = ref<string | null>(null)
const draftDeviceOverride = ref(false)

const selectedDeviceOption = computed(
  () => props.deviceOptions.find((option) => option.key === props.selectedDeviceKey) ?? null,
)

function deviceCategoryLabel(category: DeviceCategory): string {
  if (category === 'dgpu') return languages.SETUP_WIZARD_DEVICE_DEDICATED || 'Dedicated GPU'
  if (category === 'igpu') return languages.SETUP_WIZARD_DEVICE_INTEGRATED || 'Integrated GPU'
  return ''
}

function openDeviceDialog() {
  draftDeviceKey.value = props.selectedDeviceKey
  draftDeviceOverride.value = false
  deviceDialogOpen.value = true
}

function saveDeviceSelection() {
  if (!draftDeviceKey.value) return
  emit('saveDevice', { key: draftDeviceKey.value, override: draftDeviceOverride.value })
  deviceDialogOpen.value = false
}

const AI_PLAYGROUND_INFO_URL = 'https://github.com/intel/ai-playground'

function backendOptionsRow(row: ComponentPanelBackendRow): ComponentPanelOptionsRow {
  return { kind: 'backend', ...row }
}

function featureOptionsRow(kind: 'cloud' | 'demo'): ComponentPanelOptionsRow {
  if (kind === 'cloud') return { kind, view: props.cloudRow }
  return { kind, view: props.demoModeRow! }
}

function toggleBackend(row: ComponentPanelBackendRow, enabled: boolean) {
  emit('toggle', { row: backendOptionsRow(row), enabled, applyMode: props.applyMode })
}

function toggleFeature(kind: 'cloud' | 'demo', enabled: boolean) {
  emit('toggle', { row: featureOptionsRow(kind), enabled, applyMode: props.applyMode })
}

function onSelectDevice(key: unknown) {
  if (typeof key === 'string') emit('selectDevice', key)
}

function onSelectMode(mode: ProductMode) {
  if (props.selectionReadOnly) return
  emit('selectMode', mode)
}
</script>

<template>
  <div class="flex gap-6 pt-6">
    <div class="flex-1 min-w-0">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
        {{ languages.SETUP_WIZARD_MODE_SECTION || 'Product Mode' }}
      </h2>
      <div class="flex flex-col gap-2">
        <label
          v-for="option in modeOptions"
          :key="option.mode"
          class="flex items-start gap-2.5 p-3 rounded-lg border transition-colors"
          :class="[
            selectedMode === option.mode
              ? 'border-primary bg-primary/10'
              : 'border-border hover:border-muted/50',
            selectionReadOnly ? 'cursor-default' : 'cursor-pointer',
          ]"
          @click="onSelectMode(option.mode)"
        >
          <div class="shrink-0 mt-0.5">
            <div
              class="w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors"
              :class="
                selectedMode === option.mode
                  ? 'border-primary bg-primary'
                  : 'border-muted-foreground'
              "
            >
              <svg
                v-if="selectedMode === option.mode"
                class="w-2.5 h-2.5 text-primary-foreground"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
              >
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
          </div>
          <div class="min-w-0">
            <div class="flex items-baseline gap-1 flex-wrap">
              <span class="text-xs font-bold text-[#00c4fa] -mr-0.5">{{ option.titleOne }}</span>
              <span class="text-xs font-bold">{{ option.titleTwo }}</span>
              <span v-if="option.subtitle" class="text-xs font-medium text-muted-foreground">{{
                option.subtitle
              }}</span>
            </div>
            <div class="flex gap-1 pt-0.5">
              <span
                v-if="recommendedMode === option.mode"
                class="text-[9px] font-semibold uppercase tracking-wider text-success"
                >{{ languages.PRODUCT_MODE_BADGE_RECOMMENDED }}</span
              >
              <span
                v-if="option.experimental"
                class="text-[9px] font-semibold uppercase tracking-wider text-gray-400"
                >{{ languages.PRODUCT_MODE_BADGE_EXPERIMENTAL }}</span
              >
            </div>
            <p class="text-[11px] text-muted-foreground pt-1 leading-snug">
              {{ option.description }}
            </p>
          </div>
        </label>
      </div>

      <!-- Hidden entirely when no GPU is detected — there is nothing to choose. -->
      <div v-if="deviceOptions.length > 0" class="pt-6">
        <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
          {{ languages.SETUP_WIZARD_DEVICE_SECTION || 'Default GPU' }}
        </h2>
        <!-- Draft (wizard): the pick is staged and applied on "Install & Continue". -->
        <template v-if="applyMode === 'draft'">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button
                type="button"
                class="w-full flex items-center justify-between gap-2 p-3 rounded-lg border border-border transition-colors text-left hover:border-muted/50"
              >
                <span class="min-w-0">
                  <span class="block text-xs font-medium truncate">{{
                    selectedDeviceOption?.label
                  }}</span>
                  <span
                    v-if="
                      selectedDeviceOption && deviceCategoryLabel(selectedDeviceOption.category)
                    "
                    class="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    {{ deviceCategoryLabel(selectedDeviceOption.category) }}
                  </span>
                </span>
                <svg
                  class="w-4 h-4 shrink-0 text-muted-foreground"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              class="w-[var(--reka-dropdown-menu-trigger-width)] min-w-0"
            >
              <DropdownMenuItem
                v-for="option in deviceOptions"
                :key="option.key"
                @select="onSelectDevice(option.key)"
              >
                <span class="min-w-0">
                  <span class="block text-xs font-medium truncate">{{ option.label }}</span>
                  <span
                    v-if="deviceCategoryLabel(option.category)"
                    class="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
                  >
                    {{ deviceCategoryLabel(option.category) }}
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <label class="flex items-center gap-2.5 pt-3 cursor-pointer">
            <Switch
              :model-value="overrideDeviceSelection"
              @update:model-value="(v: boolean) => emit('overrideDevice', v)"
            />
            <span class="text-xs text-muted-foreground">
              {{
                languages.SETUP_WIZARD_DEVICE_OVERRIDE ||
                'Override existing preset device selections'
              }}
            </span>
          </label>
        </template>

        <!-- Live (Component Manager): the current default, changed through a dialog. -->
        <template v-else>
          <div
            role="group"
            :aria-label="languages.SETUP_WIZARD_DEVICE_SECTION || 'Default GPU'"
            class="flex items-center justify-between gap-2 p-3 rounded-lg border border-border"
          >
            <span class="min-w-0">
              <span class="block text-xs font-medium truncate">{{
                selectedDeviceOption?.label
              }}</span>
              <span
                v-if="selectedDeviceOption && deviceCategoryLabel(selectedDeviceOption.category)"
                class="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
              >
                {{ deviceCategoryLabel(selectedDeviceOption.category) }}
              </span>
            </span>
            <Button variant="outline" size="sm" @click="openDeviceDialog">
              {{ languages.COMPONENT_MANAGER_DEFAULT_GPU_CHANGE || 'Change' }}
            </Button>
          </div>

          <Dialog v-model:open="deviceDialogOpen">
            <DialogContent class="max-w-md">
              <DialogHeader>
                <DialogTitle>{{
                  languages.SETUP_WIZARD_DEVICE_SECTION || 'Default GPU'
                }}</DialogTitle>
                <DialogDescription>
                  {{
                    languages.COMPONENT_MANAGER_DEFAULT_GPU_DESCRIPTION ||
                    'New presets use this GPU. Existing Sessions keep the device they were set up with.'
                  }}
                </DialogDescription>
              </DialogHeader>

              <RadioGroup
                v-model="draftDeviceKey"
                :aria-label="languages.COMPONENT_MANAGER_DEFAULT_GPU_OPTIONS || 'Detected GPUs'"
                class="flex flex-col gap-2"
              >
                <div
                  v-for="(option, index) in deviceOptions"
                  :key="option.key"
                  class="flex items-start gap-2"
                >
                  <RadioGroupItem
                    :id="`default-gpu-option-${index}`"
                    :value="option.key"
                    class="mt-0.5"
                  />
                  <label :for="`default-gpu-option-${index}`" class="flex flex-col cursor-pointer">
                    <span class="text-xs font-medium">{{ option.label }}</span>
                    <span
                      v-if="deviceCategoryLabel(option.category)"
                      class="text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
                    >
                      {{ deviceCategoryLabel(option.category) }}
                    </span>
                  </label>
                </div>
              </RadioGroup>

              <label class="flex items-center gap-2.5 cursor-pointer">
                <Switch v-model="draftDeviceOverride" />
                <span class="text-xs text-muted-foreground">
                  {{
                    languages.SETUP_WIZARD_DEVICE_OVERRIDE ||
                    'Override existing preset device selections'
                  }}
                </span>
              </label>

              <p class="text-xs text-muted-foreground">
                {{
                  languages.COMPONENT_MANAGER_DEFAULT_GPU_SESSION_HINT ||
                  "To change one Session's device, open its Inferencing settings and set the Inference Device."
                }}
              </p>

              <DialogFooter>
                <Button variant="ghost" @click="deviceDialogOpen = false">{{
                  languages.COM_CANCEL || 'Cancel'
                }}</Button>
                <Button :disabled="!draftDeviceKey" @click="saveDeviceSelection">
                  {{ languages.COMPONENT_MANAGER_DEFAULT_GPU_SAVE || 'Save' }}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </template>
      </div>
    </div>

    <div class="flex-1 min-w-0">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
        {{ languages.SETUP_WIZARD_BACKENDS_SECTION || 'Components' }}
      </h2>

      <div class="flex flex-col gap-1.5">
        <!-- Core cannot be turned off, so the group toggle drives only the optional
             members (Channels, Hybrid Cloud) — never the nested speech sidecars. -->
        <SetupWizardGroup
          title="AI Playground"
          :info-url="AI_PLAYGROUND_INFO_URL"
          :toggle="groupToggle"
          @toggle="(v: boolean) => emit('groupToggle', v)"
        >
          <Collapsible
            v-if="coreRow"
            :open="coreServicesOpen"
            class="flex min-w-0 flex-col"
            @update:open="(v: boolean) => emit('update:coreServicesOpen', v)"
          >
            <SetupWizardRow
              :row="coreRow.view"
              compact
              @toggle="(v: boolean) => toggleBackend(coreRow!, v)"
              @repair="emit('repair', backendOptionsRow(coreRow!))"
              @show-error="emit('showError', backendOptionsRow(coreRow!))"
              @install="emit('install', backendOptionsRow(coreRow!))"
              @update="emit('update', backendOptionsRow(coreRow!))"
            >
              <template v-if="coreDependentRows.length > 0" #disclosure>
                <CollapsibleTrigger
                  :aria-label="`${coreRow.view.displayName} details`"
                  class="size-4 inline-flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors"
                >
                  <ChevronDownIcon
                    class="size-3.5 origin-center transition-transform"
                    :class="{ 'rotate-180': coreServicesOpen }"
                  />
                </CollapsibleTrigger>
              </template>
              <template #options>
                <slot name="options" :row="backendOptionsRow(coreRow)" />
              </template>
            </SetupWizardRow>

            <CollapsibleContent v-if="coreDependentRows.length > 0">
              <SetupWizardRow
                v-for="row in coreDependentRows"
                :key="row.serviceName"
                :row="row.view"
                compact
                nested
                @toggle="(v: boolean) => toggleBackend(row, v)"
                @repair="emit('repair', backendOptionsRow(row))"
                @show-error="emit('showError', backendOptionsRow(row))"
                @install="emit('install', backendOptionsRow(row))"
                @update="emit('update', backendOptionsRow(row))"
              >
                <template #options>
                  <slot name="options" :row="backendOptionsRow(row)" />
                </template>
              </SetupWizardRow>
            </CollapsibleContent>
          </Collapsible>

          <SetupWizardRow
            v-for="row in groupRows"
            :key="row.serviceName"
            :row="row.view"
            compact
            @toggle="(v: boolean) => toggleBackend(row, v)"
            @repair="emit('repair', backendOptionsRow(row))"
            @show-error="emit('showError', backendOptionsRow(row))"
            @install="emit('install', backendOptionsRow(row))"
            @update="emit('update', backendOptionsRow(row))"
          >
            <template #options>
              <slot name="options" :row="backendOptionsRow(row)" />
            </template>
          </SetupWizardRow>

          <SetupWizardRow
            :row="cloudRow"
            compact
            @toggle="(v: boolean) => toggleFeature('cloud', v)"
          >
            <template #options>
              <slot name="options" :row="featureOptionsRow('cloud')" />
            </template>
          </SetupWizardRow>

          <SetupWizardRow
            v-if="demoModeRow"
            :row="demoModeRow"
            compact
            @toggle="(v: boolean) => toggleFeature('demo', v)"
          >
            <template #options>
              <slot name="options" :row="featureOptionsRow('demo')" />
            </template>
          </SetupWizardRow>
        </SetupWizardGroup>

        <SetupWizardRow
          v-for="row in ungroupedRows"
          :key="row.serviceName"
          :row="row.view"
          @toggle="(v: boolean) => toggleBackend(row, v)"
          @repair="emit('repair', backendOptionsRow(row))"
          @show-error="emit('showError', backendOptionsRow(row))"
          @install="emit('install', backendOptionsRow(row))"
          @update="emit('update', backendOptionsRow(row))"
        >
          <template #options>
            <slot name="options" :row="backendOptionsRow(row)" />
          </template>
        </SetupWizardRow>

        <div
          v-if="phisonRow"
          class="flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-muted/30 transition-colors border-success/25"
        >
          <TooltipProvider :delay-duration="200">
            <Tooltip>
              <TooltipTrigger as-child>
                <span
                  class="w-2.5 h-2.5 rounded-full shrink-0"
                  :style="{ backgroundColor: phisonRow.statusColor }"
                ></span>
              </TooltipTrigger>
              <TooltipContent side="right" class="text-xs">
                {{ phisonRow.statusText }}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>

          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-1.5">
              <span
                class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-success"
                aria-hidden="true"
              >
                <svg class="h-5 w-5" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M4 7a2 2 0 012-2h12a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V7z"
                    stroke="currentColor"
                    stroke-width="1.75"
                  />
                  <path
                    d="M8 11h8M8 15h5"
                    stroke="currentColor"
                    stroke-width="1.5"
                    stroke-linecap="round"
                  />
                </svg>
              </span>
              <span class="text-sm font-medium leading-tight">{{ phisonRow.displayName }}</span>
            </div>
            <div
              v-if="phisonRow.versionDisplay"
              class="text-xs text-muted-foreground leading-tight"
            >
              {{ phisonRow.versionDisplay }}
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            <template v-if="phisonRow.isInstalling">
              <span
                v-if="phisonRow.installProgressText"
                class="text-xs text-muted-foreground whitespace-nowrap"
              >
                {{ phisonRow.installProgressText }}
              </span>
              <span class="svg-icon i-loading flex-none w-4 h-4"></span>
            </template>
          </div>

          <!-- Gear before toggle, matching SetupWizardRow so every switch lines up. -->
          <div class="flex items-center gap-2 shrink-0">
            <slot name="phison-options" />
            <TooltipProvider :delay-duration="300">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="inline-flex">
                    <Switch
                      :model-value="phisonRow.enabled"
                      :disabled="phisonRow.toggleDisabled"
                      @update:model-value="(v: boolean) => emit('togglePhison', v)"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="left" class="text-xs">
                  {{ phisonRow.toggleTooltip }}
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
        </div>
      </div>
      <p v-if="applyMode === 'draft'" class="text-xs text-muted-foreground pt-3">
        {{
          languages.SETUP_WIZARD_BACKENDS_INTRO ||
          'Required components will be installed automatically. Optional components can be toggled on or off.'
        }}
      </p>
      <p v-else class="text-xs text-muted-foreground pt-3">
        {{ languages.BACKEND_TERMS_AND_CONDITIONS }}
      </p>
    </div>
  </div>
</template>
