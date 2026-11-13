<template>
  <div class="pt-4">
    <AppSettingsRow label="Demo Mode" :disabled="disabled">
      <template v-if="disabled" #description>
        <div class="flex flex-col items-start gap-2">
          <span>{{ languages.SETTINGS_DEMO_MODE_NEEDS_PASSCODE }}</span>
          <Button variant="outline" size="sm" @click="setupWizard.openWizard('demoModeSetup')">
            {{ languages.SETTINGS_DEMO_MODE_SET_PASSCODE }}
          </Button>
        </div>
      </template>
      <template #default="{ id, describedBy }">
        <Switch
          :id="id"
          :model-value="demoMode.enabled"
          :disabled="disabled"
          :aria-describedby="describedBy"
          @update:model-value="requestToggle"
        />
      </template>
    </AppSettingsRow>
  </div>
  <DemoModePasscodeDialog
    v-model:open="passcodeDialogOpen"
    :verify="demoMode.verifyPasscode"
    @confirmed="demoMode.setEnabled(false)"
  />
  <DemoModeEnterConfirmDialog
    v-model:open="confirmEnterOpen"
    @confirmed="demoMode.setEnabled(true)"
  />
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useI18N } from '@/assets/js/store/i18n'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import DemoModePasscodeDialog from '@/components/DemoModePasscodeDialog.vue'
import DemoModeEnterConfirmDialog from '@/components/DemoModeEnterConfirmDialog.vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

defineProps<{ disabled?: boolean }>()

const demoMode = useDemoMode()
const setupWizard = useSetupWizard()
const languages = useI18N().state
const passcodeDialogOpen = ref(false)
const confirmEnterOpen = ref(false)

// The switch only follows demoMode.enabled; it flips once a dialog confirms.
function requestToggle(on: boolean) {
  if (on) confirmEnterOpen.value = true
  else passcodeDialogOpen.value = true
}
</script>
