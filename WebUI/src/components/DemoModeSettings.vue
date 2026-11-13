<template>
  <div class="pt-4">
    <AppSettingsRow label="Demo Mode">
      <Button id="demo-mode-toggle" variant="destructive" size="sm" @click="handleClick">
        {{ demoMode.enabled ? 'Leave' : 'Enter' }}
      </Button>
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
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import { Button } from '@/components/ui/button'
import { useDemoMode } from '@/assets/js/store/demoMode'
import DemoModePasscodeDialog from '@/components/DemoModePasscodeDialog.vue'
import DemoModeEnterConfirmDialog from '@/components/DemoModeEnterConfirmDialog.vue'

const demoMode = useDemoMode()
const passcodeDialogOpen = ref(false)
const confirmEnterOpen = ref(false)

function handleClick() {
  if (demoMode.enabled) {
    passcodeDialogOpen.value = true
  } else {
    confirmEnterOpen.value = true
  }
}
</script>
