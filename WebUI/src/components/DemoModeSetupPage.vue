<template>
  <div class="px-12 py-5 max-w-5xl w-5xl">
    <h1 class="text-center py-1 px-4 rounded-sm text-3xl font-bold">
      {{ t('DEMO_MODE_SETUP_TITLE') }}
    </h1>
    <p class="text-center text-xs text-muted-foreground pt-2">
      {{ t('DEMO_MODE_SETUP_INTRO') }}
    </p>

    <form class="flex flex-col gap-4 pt-6 max-w-md mx-auto" @submit.prevent="done">
      <p class="text-xs text-muted-foreground">{{ t('DEMO_MODE_SETUP_STORED_USER') }}</p>

      <div class="flex flex-col gap-1.5">
        <Label for="demo-passcode">{{ t('DEMO_MODE_SETUP_PASSCODE') }}</Label>
        <Input
          id="demo-passcode"
          v-model="passcode"
          type="password"
          autocomplete="new-password"
          :placeholder="wizard.demoModeHasPasscode ? t('DEMO_MODE_SETUP_PASSCODE_KEEP') : ''"
        />
      </div>
      <div class="flex flex-col gap-1.5">
        <Label for="demo-passcode-confirm">{{ t('DEMO_MODE_SETUP_PASSCODE_CONFIRM') }}</Label>
        <Input
          id="demo-passcode-confirm"
          v-model="passcodeConfirm"
          type="password"
          autocomplete="new-password"
          :aria-invalid="passcodeMismatch || undefined"
        />
        <span v-if="passcodeMismatch" role="alert" class="text-xs text-destructive">
          {{ t('DEMO_MODE_SETUP_PASSCODE_MISMATCH') }}
        </span>
        <span v-else-if="passcodeMissing" role="alert" class="text-xs text-destructive">
          {{ t('DEMO_MODE_SETUP_PASSCODE_REQUIRED') }}
        </span>
      </div>

      <div class="flex flex-col gap-1.5">
        <Label for="demo-reset-timeout">{{ t('DEMO_MODE_SETUP_RESET_TIMEOUT') }}</Label>
        <Input
          id="demo-reset-timeout"
          v-model="resetTimeout"
          type="number"
          min="1"
          step="1"
          inputmode="numeric"
          :aria-invalid="resetTimeoutInvalid || undefined"
        />
        <span v-if="resetTimeoutInvalid" role="alert" class="text-xs text-destructive">
          {{ t('DEMO_MODE_SETUP_RESET_TIMEOUT_INVALID') }}
        </span>
        <span v-else class="text-xs text-muted-foreground">
          {{ t('DEMO_MODE_SETUP_RESET_TIMEOUT_HINT') }}
        </span>
      </div>
    </form>

    <SetupWizardFooter
      :primary-label="t('DEMO_MODE_SETUP_DONE')"
      :primary-disabled="!canSave || hashing"
      @back="wizard.cancelDemoModeSetup()"
      @primary="done"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSetupWizard } from '@/assets/js/store/setupWizard'
import { useI18N } from '@/assets/js/store/i18n'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import SetupWizardFooter from '@/components/SetupWizardFooter.vue'
import { hashDemoPasscode } from '@/lib/demoPasscode'

const wizard = useSetupWizard()
const i18n = useI18N()

function t(key: string) {
  return i18n.state[key] ?? key
}

const passcode = ref('')
const passcodeConfirm = ref('')
const resetTimeout = ref<string | number>(wizard.demoModeView.resetInSeconds ?? '')
const hashing = ref(false)

const willBeEnabled = computed(() => wizard.demoModeView.enabled || wizard.demoModeSetupEnabling)
const passcodeMismatch = computed(
  () => passcodeConfirm.value !== '' && passcode.value !== passcodeConfirm.value,
)
const passcodeMissing = computed(
  () => willBeEnabled.value && !wizard.demoModeHasPasscode && passcode.value === '',
)
const parsedResetTimeout = computed(() => {
  const text = String(resetTimeout.value).trim()
  if (text === '') return null
  const value = Number(text)
  return Number.isInteger(value) && value >= 1 ? value : undefined
})
const resetTimeoutInvalid = computed(() => parsedResetTimeout.value === undefined)

const canSave = computed(
  () =>
    !passcodeMissing.value &&
    !resetTimeoutInvalid.value &&
    passcode.value === passcodeConfirm.value,
)

async function done() {
  const resetInSeconds = parsedResetTimeout.value
  if (!canSave.value || hashing.value || resetInSeconds === undefined) return
  hashing.value = true
  try {
    const passcodeHash = passcode.value ? await hashDemoPasscode(passcode.value) : undefined
    wizard.applyDemoModeSetup({ passcodeHash, resetInSeconds })
  } finally {
    hashing.value = false
  }
}
</script>
