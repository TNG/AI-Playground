<template>
  <div
    class="z-10 text-foreground rounded-xl bg-background/70 backdrop-blur-sm border border-border shadow-lg"
  >
    <HomeAgentSetupPage
      v-if="wizard.wizardPage === 'homeAgentSetup' && homeAgent.isFeatureEnabled"
      @back="wizard.wizardPage = 'main'"
      @done="wizard.finishHomeAgentSetup()"
    />

    <CloudModeSetupPage
      v-else-if="wizard.wizardPage === 'cloudModeSetup' && cloudMode.isFeatureEnabled"
      @back="wizard.wizardPage = 'main'"
      @done="wizard.finishCloudModeSetup()"
    />

    <template v-else>
      <div class="px-12 py-5 max-w-5xl w-5xl">
        <h1 class="text-center py-1 px-4 rounded-sm text-3xl font-bold">
          {{ languages.SETUP_WIZARD_TITLE || 'AI Playground Setup' }}
        </h1>
        <!-- The app version. It used to ride on the Core Services row, where it
             read as that one component's version; it is the version of the whole
             app, so it belongs under the title. -->
        <p v-if="appVersion" class="text-center text-xs text-muted-foreground">
          {{ appVersion }}
        </p>

        <!-- Two-column layout: Product Mode | Components -->
        <div class="flex gap-6 pt-6">
          <!-- Left column: Product Mode -->
          <div class="flex-1 min-w-0">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
              {{ languages.SETUP_WIZARD_MODE_SECTION || 'Product Mode' }}
            </h2>
            <div class="flex flex-col gap-2">
              <label
                v-for="option in resolvedModeOptions"
                :key="option.mode"
                class="flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors"
                :class="
                  wizard.pendingProductMode === option.mode
                    ? 'border-primary bg-primary/10'
                    : 'border-border hover:border-muted/50'
                "
                @click="wizard.setPendingMode(option.mode)"
              >
                <div class="shrink-0 mt-0.5">
                  <div
                    class="w-4 h-4 rounded-full border-2 flex items-center justify-center transition-colors"
                    :class="
                      wizard.pendingProductMode === option.mode
                        ? 'border-primary bg-primary'
                        : 'border-muted-foreground'
                    "
                  >
                    <svg
                      v-if="wizard.pendingProductMode === option.mode"
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
                    <span class="text-xs font-bold text-[#00c4fa] -mr-0.5">{{
                      option.titleOne
                    }}</span>
                    <span class="text-xs font-bold">{{ option.titleTwo }}</span>
                    <span
                      v-if="option.subtitle"
                      class="text-xs font-medium text-muted-foreground"
                      >{{ option.subtitle }}</span
                    >
                  </div>
                  <div class="flex gap-1 pt-0.5">
                    <span
                      v-if="recommendedMode === option.mode"
                      class="text-[9px] font-semibold uppercase tracking-wider text-green-500"
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

            <!-- Default GPU selection. Lives inside the left column, directly
                 under the mode options, so it shares that column's width instead
                 of spanning the whole wizard and leaving a gap. Hidden entirely
                 when no GPU is detected — there is nothing to choose. -->
            <div v-if="wizard.preferredDeviceOptions.length > 0" class="pt-6">
              <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
                {{ languages.SETUP_WIZARD_DEVICE_SECTION || 'Default GPU' }}
              </h2>
              <DropdownMenu>
                <DropdownMenuTrigger as-child>
                  <button
                    type="button"
                    class="w-full flex items-center justify-between gap-2 p-3 rounded-lg border border-border hover:border-muted/50 transition-colors text-left"
                  >
                    <span class="min-w-0">
                      <span class="block text-xs font-medium truncate">{{
                        selectedDeviceOption?.label
                      }}</span>
                      <span
                        v-if="
                          selectedDeviceOption &&
                          (selectedDeviceOption.category === 'dgpu' ||
                            selectedDeviceOption.category === 'igpu')
                        "
                        class="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {{
                          selectedDeviceOption.category === 'dgpu'
                            ? languages.SETUP_WIZARD_DEVICE_DEDICATED || 'Dedicated GPU'
                            : languages.SETUP_WIZARD_DEVICE_INTEGRATED || 'Integrated GPU'
                        }}
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
                    v-for="option in wizard.preferredDeviceOptions"
                    :key="option.key"
                    @select="onSelectPreferredDevice(option.key)"
                  >
                    <span class="min-w-0">
                      <span class="block text-xs font-medium truncate">{{ option.label }}</span>
                      <span
                        v-if="option.category === 'dgpu' || option.category === 'igpu'"
                        class="block text-[9px] font-semibold uppercase tracking-wider text-muted-foreground"
                      >
                        {{
                          option.category === 'dgpu'
                            ? languages.SETUP_WIZARD_DEVICE_DEDICATED || 'Dedicated GPU'
                            : languages.SETUP_WIZARD_DEVICE_INTEGRATED || 'Integrated GPU'
                        }}
                      </span>
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              <!-- Override toggle: always offered. When on, committing
                   overwrites every preset's saved device with the chosen
                   default above (and switches the active preset live). -->
              <label class="flex items-center gap-2.5 pt-3 cursor-pointer">
                <Switch
                  :model-value="wizard.overrideExistingDeviceSelection"
                  @update:model-value="(v: boolean) => (wizard.overrideExistingDeviceSelection = v)"
                />
                <span class="text-xs text-muted-foreground">
                  {{
                    languages.SETUP_WIZARD_DEVICE_OVERRIDE ||
                    'Override existing preset device selections'
                  }}
                </span>
              </label>
            </div>
          </div>

          <!-- Right column: Components -->
          <div class="flex-1 min-w-0">
            <h2 class="text-sm font-semibold uppercase tracking-wider text-muted-foreground pb-3">
              {{ languages.SETUP_WIZARD_BACKENDS_SECTION || 'Components' }}
            </h2>

            <div class="flex flex-col gap-1.5">
              <!-- AI Playground: the core service plus the features layered on it.
                   Core cannot be turned off, so the group toggle drives only the
                   optional members (Home Agent, Cloud Mode). -->
              <SetupWizardGroup
                title="AI Playground"
                :info-url="AI_PLAYGROUND_INFO_URL"
                :toggle="aiPlaygroundGroupToggle"
                @toggle="setAiPlaygroundGroup"
              >
                <SetupWizardRow
                  v-for="row in aiPlaygroundRows"
                  :key="row.serviceName"
                  :row="backendRowView(row)"
                  compact
                  @toggle="(v) => wizard.toggleBackend(row.serviceName, v)"
                  @repair="wizard.repairBackend(row.serviceName)"
                  @show-error="wizard.showErrorModal(row.serviceName)"
                >
                  <template #options>
                    <BackendOptions :backend="row.serviceName" />
                  </template>
                </SetupWizardRow>

                <!-- Cloud Mode: frontend-only component (remote OpenAI-compatible
                     provider). Not a real backend service, but rendered identically
                     to a regular backend row via the shared component. -->
                <SetupWizardRow :row="cloudRow" compact @toggle="(v) => cloudMode.toggleFeature(v)">
                  <template #options>
                    <!-- Identical to the Home Agent gear menu (see BackendOptions):
                         a single "Setup" item that opens the setup page. -->
                    <SettingsMenu
                      v-model:open="cloudMenuOpen"
                      label="Cloud Mode"
                      title="Configure Cloud Mode providers"
                      :disabled="!cloudMode.isFeatureEnabled"
                    >
                      <DropdownMenuItem @select="openCloudSetup">{{
                        languages.COM_GO_TO_SETUP || 'Setup'
                      }}</DropdownMenuItem>
                    </SettingsMenu>
                  </template>
                </SetupWizardRow>
              </SetupWizardGroup>

              <!-- Audio: the two standalone speech sidecars. Both run in every
                   product mode; OpenVINO covers the same two features with
                   different engines, which the ⓘ hints explain. -->
              <SetupWizardGroup
                v-if="audioRows.length > 0"
                title="Audio"
                :info-tooltip="audioGroupHint"
                :toggle="audioGroupToggle"
                @toggle="setAudioGroup"
              >
                <SetupWizardRow
                  v-for="row in audioRows"
                  :key="row.serviceName"
                  :row="backendRowView(row)"
                  compact
                  @toggle="(v) => wizard.toggleBackend(row.serviceName, v)"
                  @repair="wizard.repairBackend(row.serviceName)"
                  @show-error="wizard.showErrorModal(row.serviceName)"
                >
                  <template #options>
                    <BackendOptions :backend="row.serviceName" />
                  </template>
                </SetupWizardRow>
              </SetupWizardGroup>

              <!-- Inference engines and everything not grouped above. -->
              <SetupWizardRow
                v-for="row in ungroupedRows"
                :key="row.serviceName"
                :row="backendRowView(row)"
                @toggle="(v) => wizard.toggleBackend(row.serviceName, v)"
                @repair="wizard.repairBackend(row.serviceName)"
                @show-error="wizard.showErrorModal(row.serviceName)"
              >
                <template #options>
                  <BackendOptions :backend="row.serviceName" />
                </template>
              </SetupWizardRow>

              <div
                v-if="wizard.phisonAidaptivRow"
                class="flex items-center gap-3 px-3 py-2.5 rounded-lg border bg-muted/30 transition-colors border-emerald-600/25"
              >
                <TooltipProvider :delay-duration="200">
                  <Tooltip>
                    <TooltipTrigger as-child>
                      <span
                        class="w-2.5 h-2.5 rounded-full shrink-0"
                        :style="{ backgroundColor: wizard.phisonAidaptivRow.statusColor }"
                      ></span>
                    </TooltipTrigger>
                    <TooltipContent side="right" class="text-xs">
                      {{ wizard.phisonAidaptivRow.statusText }}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>

                <div class="flex-1 min-w-0">
                  <div class="flex items-center gap-1.5">
                    <span
                      class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded text-emerald-600 dark:text-emerald-400"
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
                    <span class="text-sm font-medium leading-tight">{{
                      wizard.phisonAidaptivRow.displayName
                    }}</span>
                  </div>
                  <div
                    v-if="wizard.phisonAidaptivRow.versionDisplay"
                    class="text-xs text-muted-foreground leading-tight"
                  >
                    {{ wizard.phisonAidaptivRow.versionDisplay }}
                  </div>
                </div>

                <div class="flex items-center gap-2 shrink-0">
                  <template v-if="wizard.phisonAidaptivRow.isInstalling">
                    <span
                      v-if="wizard.phisonAidaptivRow.installProgressText"
                      class="text-xs text-muted-foreground whitespace-nowrap"
                    >
                      {{ wizard.phisonAidaptivRow.installProgressText }}
                    </span>
                    <span class="svg-icon i-loading flex-none w-4 h-4"></span>
                  </template>
                </div>

                <!-- Gear before toggle, matching SetupWizardRow so this row's
                     switch lines up with every other one. -->
                <div class="flex items-center gap-2 shrink-0">
                  <PhisonAidaptivOptions />
                  <TooltipProvider :delay-duration="300">
                    <Tooltip>
                      <TooltipTrigger as-child>
                        <span class="inline-flex">
                          <Switch
                            :model-value="wizard.phisonAidaptivRow.enabled"
                            :disabled="wizard.phisonAidaptivRow.toggleDisabled"
                            @update:model-value="(v: boolean) => wizard.togglePhisonAidaptiv(v)"
                          />
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="left" class="text-xs">
                        {{ wizard.phisonAidaptivRow.toggleTooltip }}
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                </div>
              </div>
            </div>
            <p class="text-xs text-muted-foreground pt-3">
              {{
                languages.SETUP_WIZARD_BACKENDS_INTRO ||
                'Required components will be installed automatically. Optional components can be toggled on or off.'
              }}
            </p>
          </div>
        </div>

        <!-- Primary CTA + Close -->
        <div class="flex items-center justify-between pt-4">
          <div class="flex items-center gap-2">
            <LanguageSelector class="max-w-40" />
            <button
              @click="openDebug"
              class="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {{ languages.COM_DEBUG || 'Debug' }}
            </button>
          </div>
          <div class="flex gap-3">
            <button
              v-if="wizard.canClose"
              @click="wizard.dismiss()"
              class="py-2 px-6 rounded text-sm font-medium border border-border hover:bg-muted transition-colors"
            >
              {{ languages.COM_CLOSE || 'Close' }}
            </button>
            <button
              :disabled="!wizard.canRunPrimary"
              @click="wizard.commitAndInstall()"
              class="bg-primary py-2 px-8 rounded text-primary-foreground text-sm font-medium disabled:opacity-50 transition-colors"
            >
              {{ wizard.primaryLabel }}
            </button>
          </div>
        </div>

        <!-- Terms -->
        <div class="pt-4">
          <p class="text-xs text-muted-foreground">{{ languages.BACKEND_TERMS_AND_CONDITIONS }}</p>
        </div>
      </div>

      <!-- Error Details Modal -->
      <ErrorDetailsModal
        :is-open="wizard.errorModalOpen"
        :service-name="wizard.errorModalServiceName ?? ''"
        :error-details="wizard.errorModalDetails"
        @close="wizard.closeErrorModal()"
      />
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSetupWizard, type BackendRowViewModel } from '@/assets/js/store/setupWizard'
import type { BackendServiceName } from '@/assets/js/store/backendServices'
import { useProductMode } from '@/assets/js/store/productMode'
import { useHomeAgent } from '@/assets/js/store/homeAgent'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useI18N } from '@/assets/js/store/i18n'
import { mapStatusToColor } from '@/lib/utils'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger, TooltipProvider } from '@/components/ui/tooltip'
import BackendOptions from '@/components/BackendOptions.vue'
import SetupWizardRow, { type SetupWizardRowView } from '@/components/SetupWizardRow.vue'
import SetupWizardGroup, { type SetupWizardGroupToggle } from '@/components/SetupWizardGroup.vue'
import SettingsMenu from '@/components/SettingsMenu.vue'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import PhisonAidaptivOptions from '@/components/PhisonAidaptivOptions.vue'
import ErrorDetailsModal from '@/components/ErrorDetailsModal.vue'
import LanguageSelector from '@/components/LanguageSelector.vue'
import HomeAgentSetupPage from '@/components/HomeAgentSetupPage.vue'
import CloudModeSetupPage from '@/components/CloudModeSetupPage.vue'

const wizard = useSetupWizard()
const productModeStore = useProductMode()
const homeAgent = useHomeAgent()
const cloudMode = useCloudMode()
const globalSetup = useGlobalSetup()
const i18n = useI18N()
const languages = i18n.state

// Same value the Core Services row used to display — the core backend's version
// IS the app version. Rendered under the wizard title now.
const appVersion = computed(() => globalSetup.state.version ?? '')

function t(key: string) {
  return i18n.state[key] ?? key
}

const recommendedMode = computed(
  () => productModeStore.hardwareRecommendation?.recommendedMode ?? null,
)

// The currently-selected preferred-device option (for the dropdown trigger label).
const selectedDeviceOption = computed(() => {
  const key = wizard.preferredDeviceKey(wizard.pendingPreferredDevice)
  return wizard.preferredDeviceOptions.find((o) => o.key === key) ?? null
})

function onSelectPreferredDevice(key: unknown) {
  if (typeof key !== 'string') return
  const option = wizard.preferredDeviceOptions.find((o) => o.key === key)
  if (option) wizard.setPendingPreferredDevice(option.value)
}

const resolvedModeOptions = computed(() => {
  const catalog = productModeStore.hardwareRecommendation?.modeCatalog ?? []
  return catalog.map((entry) => ({
    mode: entry.mode,
    experimental: entry.experimental,
    titleOne: t(entry.ui.i18n.titleOne),
    titleTwo: t(entry.ui.i18n.titleTwo),
    subtitle: entry.ui.i18n.subtitle ? t(entry.ui.i18n.subtitle) : '',
    description: t(entry.ui.i18n.description),
    supportedHardware: t(entry.ui.i18n.supportedHardware),
  }))
})

// --- Row grouping ---------------------------------------------------------
// The flat list of every backend had grown long enough that related pieces read
// as unrelated peers. Two groups fix that; anything not named here keeps its own
// full-width row, in the order the store returns it.
const AI_PLAYGROUND_GROUP: BackendServiceName[] = ['ai-backend', 'home-agent-backend']
const AUDIO_GROUP: BackendServiceName[] = ['qwen3-tts-backend', 'whisper-backend']

const aiPlaygroundRows = computed(() =>
  wizard.backendRows.filter((r) => AI_PLAYGROUND_GROUP.includes(r.serviceName)),
)
const audioRows = computed(() =>
  wizard.backendRows.filter((r) => AUDIO_GROUP.includes(r.serviceName)),
)
const ungroupedRows = computed(() =>
  wizard.backendRows.filter(
    (r) => !AI_PLAYGROUND_GROUP.includes(r.serviceName) && !AUDIO_GROUP.includes(r.serviceName),
  ),
)

/**
 * A group's master toggle reflects and drives only the members that can actually
 * be toggled: a required backend (Core Services) is never touched, so the switch
 * does not snap back to "on" the moment the user turns the group off. `null` when
 * nothing in the group is toggleable — the group then renders without a switch.
 */
function groupToggle(
  rows: BackendRowViewModel[],
  extra?: { enabled: boolean },
): SetupWizardGroupToggle | null {
  const toggleable = rows.filter((r) => !r.toggleDisabled)
  if (toggleable.length === 0 && !extra) return null
  const enabled = toggleable.some((r) => r.enabled) || extra?.enabled === true
  const disabled = rows.some((r) => r.isInstalling)
  return {
    enabled,
    disabled,
    tooltip: disabled
      ? 'Installation in progress'
      : enabled
        ? 'Toggle off to disable every optional component in this group'
        : 'Toggle on to enable every optional component in this group',
  }
}

const aiPlaygroundGroupToggle = computed(() =>
  groupToggle(aiPlaygroundRows.value, { enabled: cloudMode.isFeatureEnabled }),
)
const audioGroupToggle = computed(() => groupToggle(audioRows.value))

async function setGroup(rows: BackendRowViewModel[], value: boolean) {
  for (const row of rows) {
    if (row.toggleDisabled) continue
    await wizard.toggleBackend(row.serviceName, value)
  }
}

async function setAiPlaygroundGroup(value: boolean) {
  await setGroup(aiPlaygroundRows.value, value)
  // Cloud Mode is opt-in and defaults to off: it needs no install, and switching
  // it on without a configured provider gains the user nothing while making the
  // row look ready. So the group's master switch never enables it — only its own
  // row toggle does. Turning the group OFF still disables it, which is what
  // "disable everything in this group" should mean.
  if (!value) await cloudMode.toggleFeature(false)
}

function setAudioGroup(value: boolean) {
  return setGroup(audioRows.value, value)
}

// OpenVINO reaches both audio features with its own engines, so the group needs to
// say whether that alternative exists in the mode being set up — on NVIDIA it does
// not, and these sidecars are the only local option.
const audioGroupHint = computed(() =>
  wizard.pendingProductMode === 'nvidia'
    ? 'Optional local speech components. OpenVINO also provides Text To Speech (Kokoro) and Speech To Text (Whisper), but it is unavailable in NVIDIA mode — so these are the only local audio engines here.'
    : 'Optional local speech components. OpenVINO provides the same two features with different engines (Kokoro for Text To Speech, Whisper for Speech To Text), so you can skip these and select OpenVINO in the audio settings instead.',
)

// Per-row ⓘ text: which engine the row installs, and what the alternative is.
function infoTooltipFor(serviceName: BackendServiceName): string | undefined {
  switch (serviceName) {
    case 'qwen3-tts-backend':
      return 'Runs Qwen3-TTS on its own sidecar, in every product mode (including NVIDIA), and is the only engine that supports created voices. OpenVINO offers Text To Speech too, using Kokoro — pick the engine in Settings → Text To Speech.'
    case 'whisper-backend':
      return 'Runs Whisper through torch on its own sidecar, in every product mode (including NVIDIA), with a choice of Whisper model sizes. OpenVINO offers Speech To Text too, serving Whisper through OVMS — pick the engine in Settings → Speech To Text.'
    default:
      return undefined
  }
}

// The project page for AI Playground itself. Shown on the group heading rather
// than on the Core Services row inside it: the link is about the product, not
// about that one service.
const AI_PLAYGROUND_INFO_URL = 'https://github.com/intel/ai-playground'

function getInfoURL(serviceName: string): string | undefined {
  switch (serviceName) {
    case 'comfyui-backend':
      return 'https://github.com/comfyanonymous/ComfyUI'
    case 'llamacpp-backend':
      return 'https://github.com/abetlen/llama-cpp-python'
    case 'openvino-backend':
      return 'https://github.com/openvinotoolkit/model_server'
    default:
      return undefined
  }
}

// Adapt a backend view model to the shared row's shape, deriving the info link
// and the failed-state actions (repair button + error log button).
function backendRowView(row: BackendRowViewModel): SetupWizardRowView {
  const failed = row.status === 'failed' || row.status === 'installationFailed'
  return {
    displayName: row.displayName,
    statusColor: row.statusColor,
    statusText: row.statusText,
    versionDisplay: row.versionDisplay,
    enabled: row.enabled,
    toggleDisabled: row.toggleDisabled,
    toggleTooltip: row.toggleTooltip,
    isInstalling: row.isInstalling,
    installProgressText: row.installProgressText,
    availableInCurrentMode: row.availableInCurrentMode,
    infoUrl: getInfoURL(row.serviceName),
    infoTooltip: infoTooltipFor(row.serviceName),
    showRepair: failed && row.availableInCurrentMode,
    repairDisabled: wizard.isBusy,
    showError: failed,
  }
}

// Cloud Mode is a frontend-only feature, but it presents as a normal backend row
// — so it must speak the same colour vocabulary as the real rows. It used to
// hardcode its own green/grey (#22c55e/#6b7280), which matched no other row, and
// went green the moment the feature was switched on even though nothing was set
// up yet. Now it goes through `mapStatusToColor` like everything else:
//   grey   = off (nothing here), mirroring "Not installed"
//   orange = on but no provider configured yet, mirroring "Installed, not running"
//   green  = on AND a provider with a base URL, i.e. actually usable
// A configured base URL is the synchronous signal for "the user completed Setup"
// (the shipped default provider has none); the API key can't be used here because
// it is loaded lazily from safeStorage and would make the dot flicker.
const cloudModeReady = computed(
  () => cloudMode.isFeatureEnabled && !!cloudMode.activeProviderBaseUrl,
)
const cloudRow = computed<SetupWizardRowView>(() => ({
  displayName: 'Cloud Mode',
  statusColor: !cloudMode.isFeatureEnabled
    ? mapStatusToColor('notInstalled')
    : cloudModeReady.value
      ? mapStatusToColor('running')
      : mapStatusToColor('notYetStarted'),
  statusText: !cloudMode.isFeatureEnabled
    ? languages.COM_DISABLED || 'Disabled'
    : cloudModeReady.value
      ? languages.COM_ENABLED || 'Enabled'
      : 'Enabled — add a provider in Setup',
  versionDisplay: '',
  enabled: cloudMode.isFeatureEnabled,
  toggleTooltip: cloudMode.isFeatureEnabled
    ? 'Toggle off to disable Cloud Mode'
    : 'Toggle on to enable Cloud Mode',
}))

const cloudMenuOpen = ref(false)
function openCloudSetup() {
  cloudMenuOpen.value = false
  void wizard.openCloudModeSetup()
}

function openDebug() {
  window.electronAPI.openDevTools()
}
</script>
