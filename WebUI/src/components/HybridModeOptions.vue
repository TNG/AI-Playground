<script setup lang="ts">
// Settings menu for the Hybrid Mode row. Uses the shared SettingsMenu so the gear
// icon opens the same dropdown menu as every other backend row instead of jumping
// straight to the setup page — keeping the wizard visually consistent.
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useHybridMode } from '@/assets/js/store/hybridMode'
import { useI18N } from '@/assets/js/store/i18n'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import SettingsMenu from '@/components/SettingsMenu.vue'

const setupWizard = useSetupWizard()
const hybridMode = useHybridMode()
const i18nState = useI18N().state

const menuOpen = ref(false)

const handleSetup = () => {
  menuOpen.value = false
  void setupWizard.openHybridModeSetup()
}
</script>

<template>
  <SettingsMenu
    v-model:open="menuOpen"
    label="Hybrid Mode"
    title="Configure Hybrid Mode providers"
    :disabled="!hybridMode.isFeatureEnabled"
  >
    <DropdownMenuItem @select="handleSetup">{{
      i18nState.COM_GO_TO_SETUP || 'Setup'
    }}</DropdownMenuItem>
  </SettingsMenu>
</template>
