<template>
  <div
    class="z-10 text-foreground rounded-xl bg-background/70 backdrop-blur-sm border border-border shadow-lg"
  >
    <ChannelsSetupPage
      v-if="wizard.wizardPage === 'channelsSetup'"
      @back="wizard.wizardPage = 'main'"
      @done="wizard.finishChannelsSetup()"
    />

    <CloudModeSetupPage
      v-else-if="wizard.wizardPage === 'cloudModeSetup' && cloudMode.isFeatureEnabled"
      @back="wizard.wizardPage = 'main'"
      @done="wizard.finishCloudModeSetup()"
    />

    <DemoModeSetupPage v-else-if="wizard.wizardPage === 'demoModeSetup'" />

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

        <ComponentPanel
          apply-mode="draft"
          :mode-options="resolvedModeOptions"
          :selected-mode="wizard.pendingProductMode"
          :recommended-mode="recommendedMode"
          :device-options="wizard.preferredDeviceOptions"
          :selected-device-key="wizard.preferredDeviceKey(wizard.pendingPreferredDevice)"
          :override-device-selection="wizard.overrideExistingDeviceSelection"
          :core-row="coreRowData"
          :core-dependent-rows="coreDependentRowData"
          :group-rows="aiPlaygroundOptionalRowData"
          :group-toggle="aiPlaygroundGroupToggle"
          :cloud-row="cloudRow"
          :demo-mode-row="demoModeRow"
          :ungrouped-rows="ungroupedRowData"
          :phison-row="wizard.phisonAidaptivRow"
          :core-services-open="coreServicesOpen"
          @select-mode="wizard.setPendingMode"
          @select-device="onSelectPreferredDevice"
          @override-device="(v: boolean) => (wizard.overrideExistingDeviceSelection = v)"
          @group-toggle="setAiPlaygroundGroup"
          @toggle="onPanelToggle"
          @repair="onPanelRepair"
          @show-error="onPanelShowError"
          @toggle-phison="wizard.togglePhisonAidaptiv"
          @update:core-services-open="(v: boolean) => (coreServicesOpen = v)"
        >
          <template #options="{ row }">
            <BackendOptions v-if="row.kind === 'backend'" :backend="row.serviceName" />
            <SettingsMenu
              v-else-if="row.kind === 'cloud'"
              v-model:open="cloudMenuOpen"
              :label="HYBRID_CLOUD_NAME"
              :title="`Configure ${HYBRID_CLOUD_NAME} providers`"
              :disabled="!cloudMode.isFeatureEnabled"
            >
              <DropdownMenuItem @select="openCloudSetup">{{
                languages.COM_GO_TO_SETUP || 'Setup'
              }}</DropdownMenuItem>
            </SettingsMenu>
            <SettingsMenu
              v-else
              v-model:open="demoModeMenuOpen"
              :label="demoModeRow.displayName"
              :title="t('SETUP_WIZARD_DEMO_MODE_OPTIONS')"
            >
              <DropdownMenuItem @select="openDemoModeSetup">{{
                languages.COM_GO_TO_SETUP || 'Setup'
              }}</DropdownMenuItem>
            </SettingsMenu>
          </template>
          <template #phison-options>
            <PhisonAidaptivOptions />
          </template>
        </ComponentPanel>

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
import { computed, ref, watch } from 'vue'
import { useSetupWizard, type BackendRowViewModel } from '@/assets/js/store/setupWizard'
import type { BackendServiceName } from '@/assets/js/store/backendServices'
import { CORE_DEPENDENT_BACKENDS } from '@/lib/wizardInstallDefaults'
import { HYBRID_CLOUD_NAME } from '@/lib/cloudModeName'
import { useProductMode } from '@/assets/js/store/productMode'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useGlobalSetup } from '@/assets/js/store/globalSetup'
import { useI18N } from '@/assets/js/store/i18n'
import { mapStatusToColor } from '@/lib/utils'
import BackendOptions from '@/components/BackendOptions.vue'
import type { SetupWizardRowView } from '@/components/SetupWizardRow.vue'
import type { SetupWizardGroupToggle } from '@/components/SetupWizardGroup.vue'
import SettingsMenu from '@/components/SettingsMenu.vue'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import ComponentPanel, {
  type ComponentPanelBackendRow,
  type ComponentPanelOptionsRow,
  type ComponentPanelToggleIntent,
} from '@/components/ComponentPanel.vue'
import PhisonAidaptivOptions from '@/components/PhisonAidaptivOptions.vue'
import ErrorDetailsModal from '@/components/ErrorDetailsModal.vue'
import LanguageSelector from '@/components/LanguageSelector.vue'
import ChannelsSetupPage from '@/components/ChannelsSetupPage.vue'
import CloudModeSetupPage from '@/components/CloudModeSetupPage.vue'
import DemoModeSetupPage from '@/components/DemoModeSetupPage.vue'

const wizard = useSetupWizard()
const productModeStore = useProductMode()
const cloudMode = useCloudMode()
const demoMode = useDemoMode()
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
// as unrelated peers. The AI Playground group fixes that; anything not named here
// keeps its own full-width row, in the order the store returns it.
const AI_PLAYGROUND_GROUP: BackendServiceName[] = ['ai-backend', 'home-agent-backend']
const CORE_DEPENDENTS: BackendServiceName[] = [...CORE_DEPENDENT_BACKENDS]

const aiPlaygroundRows = computed(() =>
  wizard.backendRows.filter((r) => AI_PLAYGROUND_GROUP.includes(r.serviceName)),
)
/** The core service itself — owner of the nested speech sidecars below. */
const coreRow = computed(
  () => wizard.backendRows.find((r) => r.serviceName === 'ai-backend') ?? null,
)
/** Optional members of the group that are NOT nested under Core Services. */
const aiPlaygroundOptionalRows = computed(() =>
  aiPlaygroundRows.value.filter((r) => r.serviceName !== 'ai-backend'),
)
const coreDependentRows = computed(() =>
  wizard.backendRows.filter((r) => CORE_DEPENDENTS.includes(r.serviceName)),
)
const ungroupedRows = computed(() =>
  wizard.backendRows.filter(
    (r) => !AI_PLAYGROUND_GROUP.includes(r.serviceName) && !CORE_DEPENDENTS.includes(r.serviceName),
  ),
)

const coreServicesNeedsAttention = computed(() =>
  coreDependentRows.value.some(
    (r) => r.isInstalling || r.status === 'failed' || r.status === 'installationFailed',
  ),
)

// Collapsed on every wizard open (this component is never unmounted, so the state
// has to be reset rather than merely initialized): the wizard reseeds everything
// else it shows, and a screen meant to read as one core install must not open on a
// previous visit's expansion. Expanded whenever a nested sidecar is working or
// broken, so a failure and its Repair button are never hidden behind the chevron.
const coreServicesOpen = ref(false)
watch(coreServicesNeedsAttention, (needsAttention) => {
  if (needsAttention) coreServicesOpen.value = true
})
watch(
  () => globalSetup.loadingState === 'setupWizard',
  (wizardVisible) => {
    if (wizardVisible) coreServicesOpen.value = coreServicesNeedsAttention.value
  },
  { immediate: true },
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
async function setGroup(rows: BackendRowViewModel[], value: boolean) {
  for (const row of rows) {
    if (row.toggleDisabled) continue
    await wizard.toggleBackend(row.serviceName, value)
  }
}

async function setAiPlaygroundGroup(value: boolean) {
  // Only the group's own optional members: the speech sidecars nested under Core
  // Services are core dependents, so a master switch meant for Channels must
  // not silently skip the app's audio runtimes. Their opt-out is their own row.
  await setGroup(aiPlaygroundRows.value, value)
  // Hybrid Cloud is opt-in and defaults to off: it needs no install, and switching
  // it on without a configured provider gains the user nothing while making the
  // row look ready. So the group's master switch never enables it — only its own
  // row toggle does. Turning the group OFF still disables it, which is what
  // "disable everything in this group" should mean.
  if (!value) await cloudMode.toggleFeature(false)
}

// Per-row ⓘ text: which engine the row installs, and what the alternative is.
// The speech rows also say whether OpenVINO can serve the same feature in the
// mode being set up — on NVIDIA it cannot, so these are the only local engines.
function infoTooltipFor(serviceName: BackendServiceName): string | undefined {
  const openVinoAvailable = wizard.pendingProductMode !== 'nvidia'
  switch (serviceName) {
    case 'qwen3-tts-backend':
      return openVinoAvailable
        ? 'Speech runtime installed with the core app; its voice models download the first time you use it. Runs Qwen3-TTS on its own sidecar and is the only engine that supports created voices. OpenVINO offers Text To Speech too, using Kokoro — pick the engine in Settings → Text To Speech.'
        : 'Speech runtime installed with the core app; its voice models download the first time you use it. Runs Qwen3-TTS on its own sidecar. OpenVINO also provides Text To Speech (Kokoro), but it is unavailable in NVIDIA mode — so this is the only local engine here.'
    case 'whisper-backend':
      return openVinoAvailable
        ? 'Speech runtime installed with the core app; its Whisper model downloads the first time you use it. Runs Whisper through torch on its own sidecar, with a choice of model sizes. OpenVINO offers Speech To Text too, serving Whisper through OVMS — pick the engine in Settings → Speech To Text.'
        : 'Speech runtime installed with the core app; its Whisper model downloads the first time you use it. Runs Whisper through torch on its own sidecar, with a choice of model sizes. OpenVINO also provides Speech To Text, but it is unavailable in NVIDIA mode — so this is the only local engine here.'
    default:
      return undefined
  }
}

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

function toPanelRows(rows: BackendRowViewModel[]): ComponentPanelBackendRow[] {
  return rows.map((row) => ({ serviceName: row.serviceName, view: backendRowView(row) }))
}

const coreRowData = computed<ComponentPanelBackendRow | null>(() =>
  coreRow.value
    ? { serviceName: coreRow.value.serviceName, view: backendRowView(coreRow.value) }
    : null,
)
const coreDependentRowData = computed(() => toPanelRows(coreDependentRows.value))
const aiPlaygroundOptionalRowData = computed(() => toPanelRows(aiPlaygroundOptionalRows.value))
const ungroupedRowData = computed(() => toPanelRows(ungroupedRows.value))

function onPanelToggle({ row, enabled }: ComponentPanelToggleIntent) {
  if (row.kind === 'cloud') void cloudMode.toggleFeature(enabled)
  else if (row.kind === 'demo') wizard.toggleDemoMode(enabled)
  else void wizard.toggleBackend(row.serviceName, enabled)
}

function onPanelRepair(row: ComponentPanelOptionsRow) {
  if (row.kind === 'backend') void wizard.repairBackend(row.serviceName)
}

function onPanelShowError(row: ComponentPanelOptionsRow) {
  if (row.kind === 'backend') wizard.showErrorModal(row.serviceName)
}

// Hybrid Cloud is a frontend-only feature, but it presents as a normal backend row
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
  displayName: HYBRID_CLOUD_NAME,
  infoTooltip:
    'Adds an OpenAI-compatible endpoint to run inference on beside this device — hosted, cloud, or another machine on your LAN. No install: point it at a provider in its Setup screen.',
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
    ? `Toggle off to disable ${HYBRID_CLOUD_NAME}`
    : `Toggle on to enable ${HYBRID_CLOUD_NAME}`,
}))

const cloudMenuOpen = ref(false)
function openCloudSetup() {
  cloudMenuOpen.value = false
  void wizard.openCloudModeSetup()
}

// Kept out of the group's master switch: Demo Mode needs a passcode and locks the app.
const demoModeRow = computed<SetupWizardRowView>(() => {
  const enabled = wizard.demoModeView.enabled
  return {
    displayName: t('SETUP_WIZARD_DEMO_MODE'),
    infoTooltip: t('SETUP_WIZARD_DEMO_MODE_INFO'),
    statusColor: mapStatusToColor(enabled ? 'notYetStarted' : 'notInstalled'),
    statusText: !enabled
      ? t('SETUP_WIZARD_DEMO_MODE_OFF')
      : demoMode.policyPresent && !wizard.demoModeChanged
        ? t('DEMO_MODE_SET_BY_ADMIN')
        : t('SETUP_WIZARD_DEMO_MODE_PENDING'),
    versionDisplay: '',
    enabled,
    toggleTooltip: enabled
      ? t('SETUP_WIZARD_DEMO_MODE_TOGGLE_OFF')
      : t('SETUP_WIZARD_DEMO_MODE_TOGGLE_ON'),
  }
})

const demoModeMenuOpen = ref(false)
function openDemoModeSetup() {
  demoModeMenuOpen.value = false
  wizard.openDemoModeSetup()
}

function openDebug() {
  window.electronAPI.openDevTools()
}
</script>
