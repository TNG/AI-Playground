<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useComponentManager, type ComponentRow } from '@/assets/js/store/componentManager'
import { useProductMode } from '@/assets/js/store/productMode'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useUIStore } from '@/assets/js/store/ui'
import { useI18N } from '@/assets/js/store/i18n'
import type { BackendServiceName } from '@/assets/js/store/backendServices'
import { CORE_DEPENDENT_BACKENDS } from '@/lib/wizardInstallDefaults'
import { HYBRID_CLOUD_NAME } from '@/lib/cloudModeName'
import { mapStatusToColor } from '@/lib/utils'
import ComponentPanel, {
  type ComponentPanelBackendRow,
  type ComponentPanelOptionsRow,
  type ComponentPanelToggleIntent,
} from '@/components/ComponentPanel.vue'
import BackendOptions from '@/components/BackendOptions.vue'
import ErrorDetailsModal from '@/components/ErrorDetailsModal.vue'
import type { SetupWizardRowView } from '@/components/SetupWizardRow.vue'
import type { SetupWizardGroupToggle } from '@/components/SetupWizardGroup.vue'
import ChannelsSetupPage from '@/components/ChannelsSetupPage.vue'
import CloudModeSetupPage from '@/components/CloudModeSetupPage.vue'
import SettingsMenu from '@/components/SettingsMenu.vue'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'

const manager = useComponentManager()
const productModeStore = useProductMode()
const cloudMode = useCloudMode()
const wizard = useSetupWizard()
const ui = useUIStore()
const i18n = useI18N()
const languages = i18n.state

const coreServicesOpen = ref(false)
const cloudMenuOpen = ref(false)
const uninstallDialogOpen = ref(false)
const uninstallTarget = ref<ComponentRow | null>(null)

onMounted(() => void manager.hydrateFromSettings())

function t(key: string): string {
  return languages[key] ?? key
}

const AI_PLAYGROUND_GROUP = ['ai-backend', 'home-agent-backend']
const CORE_DEPENDENTS: BackendServiceName[] = [...CORE_DEPENDENT_BACKENDS]

const coreRow = computed(() => manager.rows.find((row) => row.serviceName === 'ai-backend') ?? null)
const coreDependentRows = computed(() =>
  manager.rows.filter((row) => CORE_DEPENDENTS.includes(row.serviceName)),
)
const aiPlaygroundOptionalRows = computed(() =>
  manager.rows.filter(
    (row) => AI_PLAYGROUND_GROUP.includes(row.serviceName) && row.serviceName !== 'ai-backend',
  ),
)
const ungroupedRows = computed(() =>
  manager.rows.filter(
    (row) =>
      !AI_PLAYGROUND_GROUP.includes(row.serviceName) && !CORE_DEPENDENTS.includes(row.serviceName),
  ),
)

function toRowView(row: ComponentRow): SetupWizardRowView {
  return {
    displayName: row.displayName,
    statusColor: row.statusColor,
    statusText: row.statusText,
    versionDisplay: row.subtitle,
    enabled: row.enabled,
    toggleDisabled: row.toggleDisabled,
    isInstalling: row.isInstalling,
    installProgressText: row.installProgressText,
    availableInCurrentMode: row.availableInCurrentMode,
    showInstall: row.canInstall,
    installLabel: (languages.COM_INSTALL_COMPONENT || 'Install {name}').replace(
      '{name}',
      row.displayName,
    ),
    showUpdate: row.updateAvailable && row.availableInCurrentMode,
    updateLabel: (languages.COM_UPDATE_TO || 'Update to {version}').replace(
      '{version}',
      row.updateTargetText,
    ),
    updateAriaLabel: (languages.COM_UPDATE_COMPONENT || 'Update {name}').replace(
      '{name}',
      row.displayName,
    ),
    showRepair: row.canRepair,
    repairDisabled: wizard.isBusy || row.inUseWork !== null,
    showUninstall: row.canUninstall,
    uninstallLabel: languages.COMPONENT_MANAGER_UNINSTALL || 'Uninstall',
    uninstallAriaLabel: (
      languages.COMPONENT_MANAGER_UNINSTALL_ACTION || 'Uninstall {name}'
    ).replace('{name}', row.displayName),
    uninstallDisabled: row.inUseWork !== null || row.isInstalling || wizard.isBusy,
    showError: row.failed,
    inUseReason: row.inUseReason ?? undefined,
    installDisabled: row.inUseWork !== null,
    updateDisabled: row.inUseWork !== null,
  }
}

function toPanelRows(rows: ComponentRow[]): ComponentPanelBackendRow[] {
  return rows.map((row) => ({ serviceName: row.serviceName, view: toRowView(row) }))
}

const coreRowData = computed<ComponentPanelBackendRow | null>(() =>
  coreRow.value ? { serviceName: coreRow.value.serviceName, view: toRowView(coreRow.value) } : null,
)
const coreDependentRowData = computed(() => toPanelRows(coreDependentRows.value))
const aiPlaygroundOptionalRowData = computed(() => toPanelRows(aiPlaygroundOptionalRows.value))
const ungroupedRowData = computed(() => toPanelRows(ungroupedRows.value))

const groupToggle = computed<SetupWizardGroupToggle | null>(() => {
  const toggleable = aiPlaygroundOptionalRows.value.filter((row) => !row.toggleDisabled)
  if (toggleable.length === 0 && !cloudMode.isFeatureEnabled) return null
  return {
    enabled: toggleable.some((row) => row.enabled) || cloudMode.isFeatureEnabled,
    disabled: aiPlaygroundOptionalRows.value.some((row) => row.isInstalling),
  }
})

async function setAiPlaygroundGroup(value: boolean) {
  for (const row of aiPlaygroundOptionalRows.value) {
    if (row.toggleDisabled) continue
    await manager.setEnabled(row.serviceName, value)
  }
  if (!value) await cloudMode.toggleFeature(false)
}

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
}))

const modeOptions = computed(() => {
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

const recommendedMode = computed(
  () => productModeStore.hardwareRecommendation?.recommendedMode ?? null,
)

const healthText = computed(() =>
  (
    languages.COMPONENT_MANAGER_HEALTH ||
    '{running} running · {updates} with updates · {attention} needing attention'
  )
    .replace('{running}', String(manager.health.running))
    .replace('{updates}', String(manager.health.updates))
    .replace('{attention}', String(manager.health.attention)),
)

function onToggle({ row, enabled }: ComponentPanelToggleIntent) {
  if (row.kind === 'backend') void manager.setEnabled(row.serviceName, enabled)
  else if (row.kind === 'cloud') void cloudMode.toggleFeature(enabled)
}

function onInstall(row: ComponentPanelOptionsRow) {
  if (row.kind === 'backend') void manager.install(row.serviceName)
}

function onRepair(row: ComponentPanelOptionsRow) {
  if (row.kind === 'backend') void manager.repair(row.serviceName)
}

function onUpdate(row: ComponentPanelOptionsRow) {
  if (row.kind === 'backend') void manager.update(row.serviceName)
}

function onUninstall(row: ComponentPanelOptionsRow) {
  if (row.kind !== 'backend') return
  const target = manager.rows.find((entry) => entry.serviceName === row.serviceName)
  if (!target?.canUninstall) return
  uninstallTarget.value = target
  uninstallDialogOpen.value = true
}

function confirmUninstall() {
  const target = uninstallTarget.value
  uninstallDialogOpen.value = false
  if (target) void manager.uninstall(target.serviceName)
}

function onShowError(row: ComponentPanelOptionsRow) {
  if (row.kind === 'backend') manager.showErrorLog(row.serviceName)
}

function onSaveDevice({ key, override }: { key: string; override: boolean }) {
  const option = manager.deviceOptions.find((entry) => entry.key === key)
  if (!option) return
  void manager.setPreferredDevice(option.value, override)
}

function onChangeMode(mode: ProductMode) {
  void manager.changeHardwareMode(mode)
}

function openCloudSetup() {
  cloudMenuOpen.value = false
  if (!cloudMode.isFeatureEnabled) return
  ui.openComponentManagerCloud()
}
</script>

<template>
  <div class="flex flex-col">
    <ChannelsSetupPage
      v-if="ui.componentManagerSubView === 'channels'"
      embedded
      @back="ui.closeComponentManagerSubView()"
      @done="ui.closeComponentManagerSubView()"
    />

    <CloudModeSetupPage
      v-else-if="ui.componentManagerSubView === 'cloud'"
      @back="ui.closeComponentManagerSubView()"
      @done="ui.closeComponentManagerSubView()"
    />

    <template v-else>
      <p role="status" class="text-sm text-muted-foreground">
        {{ healthText }}
      </p>

      <ComponentPanel
        apply-mode="live"
        :mode-options="modeOptions"
        :selected-mode="productModeStore.productMode"
        :recommended-mode="recommendedMode"
        :mode-change-blocked="manager.hardwareModeChangeBlocked"
        :mode-change-reason="manager.hardwareModeChangeReason"
        :device-options="manager.deviceOptions"
        :selected-device-key="manager.selectedDeviceKey"
        :override-device-selection="false"
        :core-row="coreRowData"
        :core-dependent-rows="coreDependentRowData"
        :group-rows="aiPlaygroundOptionalRowData"
        :group-toggle="groupToggle"
        :cloud-row="cloudRow"
        :demo-mode-row="null"
        :ungrouped-rows="ungroupedRowData"
        :phison-row="wizard.phisonAidaptivRow"
        :core-services-open="coreServicesOpen"
        @change-mode="onChangeMode"
        @group-toggle="setAiPlaygroundGroup"
        @toggle="onToggle"
        @repair="onRepair"
        @show-error="onShowError"
        @install="onInstall"
        @update="onUpdate"
        @uninstall="onUninstall"
        @save-device="onSaveDevice"
        @toggle-phison="wizard.togglePhisonAidaptiv"
        @update:core-services-open="(value: boolean) => (coreServicesOpen = value)"
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
              languages.COM_GO_TO_SETUP || 'Go to Setup'
            }}</DropdownMenuItem>
          </SettingsMenu>
        </template>
      </ComponentPanel>

      <ErrorDetailsModal
        :is-open="wizard.errorModalOpen"
        :service-name="wizard.errorModalServiceName ?? ''"
        :error-details="wizard.errorModalDetails"
        @close="wizard.closeErrorModal()"
      />

      <AlertDialog v-if="uninstallTarget" v-model:open="uninstallDialogOpen">
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {{
                (languages.COMPONENT_MANAGER_UNINSTALL_TITLE || 'Uninstall {name}?').replace(
                  '{name}',
                  uninstallTarget.displayName,
                )
              }}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <span class="block">{{ uninstallTarget.uninstallStopsText }}</span>
              <span class="block pt-2">
                {{
                  languages.COMPONENT_MANAGER_UNINSTALL_KEEPS_WEIGHTS ||
                  'Only the runtime is removed. Model weights are kept, so reinstalling does not download them again.'
                }}
              </span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel @click="uninstallTarget = null">{{
              languages.COM_CANCEL || 'Cancel'
            }}</AlertDialogCancel>
            <AlertDialogAction @click="confirmUninstall">{{
              languages.COMPONENT_MANAGER_UNINSTALL || 'Uninstall'
            }}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </template>
  </div>
</template>
