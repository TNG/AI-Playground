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
import { ChevronDownIcon } from '@heroicons/vue/24/outline'
import ComponentDefaultGpu from '@/components/ComponentDefaultGpu.vue'
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
  /** Live mode: the Hardware Mode change is refused while any In-flight Work exists. */
  modeChangeBlocked?: boolean
  /** Why the Hardware Mode change is blocked, e.g. "Finish the running work first". */
  modeChangeReason?: string | null
}>()

defineSlots<{
  /** The settings menu (gear) for a backend, Cloud Mode or Demo Mode row. */
  options?: (props: { row: ComponentPanelOptionsRow }) => unknown
  /** The settings menu for the Phison aiDAPTIV row. */
  'phison-options'?: () => unknown
}>()

const emit = defineEmits<{
  selectMode: [mode: ProductMode]
  changeMode: [mode: ProductMode]
  selectDevice: [key: string]
  overrideDevice: [value: boolean]
  saveDevice: [intent: { key: string; override: boolean }]
  groupToggle: [value: boolean]
  toggle: [intent: ComponentPanelToggleIntent]
  repair: [row: ComponentPanelOptionsRow]
  showError: [row: ComponentPanelOptionsRow]
  install: [row: ComponentPanelOptionsRow]
  update: [row: ComponentPanelOptionsRow]
  uninstall: [row: ComponentPanelOptionsRow]
  togglePhison: [value: boolean]
  'update:coreServicesOpen': [value: boolean]
}>()

const languages = useI18N().state

const modeDialogOpen = ref(false)
const draftMode = ref<ProductMode | null>(null)

const currentModeOption = computed(
  () => props.modeOptions.find((option) => option.mode === props.selectedMode) ?? null,
)
const draftModeOption = computed(
  () => props.modeOptions.find((option) => option.mode === draftMode.value) ?? null,
)
const canApplyMode = computed(
  () => draftModeOption.value !== null && draftMode.value !== props.selectedMode,
)

function modeTitle(option: ComponentPanelModeOption): string {
  return [option.titleOne, option.titleTwo].filter(Boolean).join(' ')
}

function modeOptionName(option: ComponentPanelModeOption): string {
  return [option.titleOne, option.titleTwo, option.subtitle].filter(Boolean).join(' ')
}

function openModeDialog() {
  draftMode.value = props.selectedMode
  modeDialogOpen.value = true
}

function confirmModeChange() {
  if (!canApplyMode.value || !draftMode.value) return
  emit('changeMode', draftMode.value)
  modeDialogOpen.value = false
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

function onSelectMode(mode: ProductMode) {
  emit('selectMode', mode)
}
</script>

<template>
  <div :class="applyMode === 'draft' ? 'flex gap-6 pt-6' : 'flex flex-col pt-6'">
    <div class="flex-1 min-w-0" :class="applyMode === 'live' ? 'order-1' : ''">
      <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
        {{ languages.SETUP_WIZARD_MODE_SECTION || 'Product Mode' }}
      </h2>

      <!-- Draft (wizard): the pick is staged and applied on "Install & Continue". -->
      <div v-if="applyMode === 'draft'" class="flex flex-col gap-2">
        <label
          v-for="option in modeOptions"
          :key="option.mode"
          class="flex items-start gap-2.5 p-3 rounded-lg border transition-colors cursor-pointer"
          :class="
            selectedMode === option.mode
              ? 'border-primary bg-primary/10'
              : 'border-border hover:border-muted/50'
          "
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

      <!-- Live (Component Manager): the current mode, changed through a confirmation. -->
      <template v-else>
        <div
          role="group"
          :aria-label="languages.SETUP_WIZARD_MODE_SECTION || 'Hardware Mode'"
          class="flex items-center justify-between gap-2 p-3 rounded-lg border border-border"
        >
          <span class="min-w-0">
            <span class="block text-xs font-medium truncate">{{
              currentModeOption ? modeTitle(currentModeOption) : ''
            }}</span>
            <span
              v-if="currentModeOption?.subtitle"
              class="block text-[11px] text-muted-foreground"
            >
              {{ currentModeOption.subtitle }}
            </span>
          </span>
          <div class="flex flex-col items-end gap-1 shrink-0">
            <Button
              variant="outline"
              size="sm"
              :disabled="modeChangeBlocked || modeOptions.length === 0"
              @click="openModeDialog"
            >
              {{ languages.COMPONENT_MANAGER_HARDWARE_MODE_CHANGE || 'Change' }}
            </Button>
            <span v-if="modeChangeBlocked && modeChangeReason" class="text-[11px] text-warning">
              {{ modeChangeReason }}
            </span>
          </div>
        </div>

        <Dialog v-model:open="modeDialogOpen">
          <DialogContent class="max-w-lg">
            <DialogHeader>
              <DialogTitle>{{
                languages.SETUP_WIZARD_MODE_SECTION || 'Hardware Mode'
              }}</DialogTitle>
              <DialogDescription>
                {{
                  languages.COMPONENT_MANAGER_HARDWARE_MODE_DESCRIPTION ||
                  'Applies immediately. Components unavailable in the new Hardware Mode are stopped but stay installed; newly available ones are offered, not installed.'
                }}
              </DialogDescription>
            </DialogHeader>

            <RadioGroup
              v-model="draftMode"
              :aria-label="languages.SETUP_WIZARD_MODE_SECTION || 'Hardware Mode'"
              class="flex flex-col gap-2"
            >
              <div
                v-for="option in modeOptions"
                :key="option.mode"
                class="flex items-start gap-2 p-3 rounded-lg border transition-colors"
                :class="
                  draftMode === option.mode
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-muted/50'
                "
              >
                <RadioGroupItem
                  :id="`hardware-mode-${option.mode}`"
                  :value="option.mode"
                  :aria-label="modeOptionName(option)"
                  class="mt-0.5"
                />
                <label :for="`hardware-mode-${option.mode}`" class="min-w-0 cursor-pointer flex-1">
                  <span class="flex items-baseline gap-1 flex-wrap">
                    <span class="text-xs font-bold text-[#00c4fa] -mr-0.5">{{
                      option.titleOne
                    }}</span>
                    <span class="text-xs font-bold">{{ option.titleTwo }}</span>
                    <span
                      v-if="option.subtitle"
                      class="text-xs font-medium text-muted-foreground"
                      >{{ option.subtitle }}</span
                    >
                  </span>
                  <span class="flex gap-1 pt-0.5">
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
                  </span>
                  <span class="block text-[11px] text-muted-foreground pt-1 leading-snug">
                    {{ option.description }}
                  </span>
                  <span class="block text-[11px] text-muted-foreground pt-1 leading-snug">
                    <span class="font-medium">{{
                      languages.COMPONENT_MANAGER_HARDWARE_MODE_SUPPORTED || 'Supported hardware'
                    }}</span
                    >: {{ option.supportedHardware }}
                  </span>
                </label>
              </div>
            </RadioGroup>

            <DialogFooter>
              <Button variant="ghost" @click="modeDialogOpen = false">{{
                languages.COM_CANCEL || 'Cancel'
              }}</Button>
              <Button :disabled="!canApplyMode" @click="confirmModeChange">
                {{ languages.COM_APPLY || 'Apply' }}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </template>

      <ComponentDefaultGpu
        v-if="applyMode === 'draft'"
        :apply-mode="applyMode"
        :device-options="deviceOptions"
        :selected-device-key="selectedDeviceKey"
        :override-device-selection="overrideDeviceSelection"
        @select-device="(key: string) => emit('selectDevice', key)"
        @override-device="(value: boolean) => emit('overrideDevice', value)"
        @save-device="(intent: { key: string; override: boolean }) => emit('saveDevice', intent)"
      />
    </div>

    <div class="flex-1 min-w-0" :class="applyMode === 'live' ? 'order-2 pt-6' : ''">
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
              @uninstall="emit('uninstall', backendOptionsRow(coreRow!))"
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
                @uninstall="emit('uninstall', backendOptionsRow(row))"
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
            @uninstall="emit('uninstall', backendOptionsRow(row))"
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
          @uninstall="emit('uninstall', backendOptionsRow(row))"
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

    <div v-if="applyMode === 'live'" class="flex-1 min-w-0 order-3">
      <ComponentDefaultGpu
        apply-mode="live"
        :device-options="deviceOptions"
        :selected-device-key="selectedDeviceKey"
        :override-device-selection="overrideDeviceSelection"
        @select-device="(key: string) => emit('selectDevice', key)"
        @override-device="(value: boolean) => emit('overrideDevice', value)"
        @save-device="(intent: { key: string; override: boolean }) => emit('saveDevice', intent)"
      />
    </div>
  </div>
</template>
