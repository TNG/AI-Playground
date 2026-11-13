<template>
  <div class="flex flex-col gap-3">
    <SettingsHeading>{{ languages.SETTINGS_MODEL_HUGGINGFACE_SETTINGS }}</SettingsHeading>
    <SettingsHeading sub>{{ languages.SETTINGS_MODEL_HUGGINGFACE_API_TOKEN }}</SettingsHeading>
    <div class="flex flex-col items-start gap-1">
      <Input
        type="password"
        v-model="models.hfToken"
        class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
        :class="{ 'border-red-500': models.hfToken && !models.hfTokenIsValid }"
      />
      <div
        class="text-xs text-red-500 select-none"
        :class="{ 'opacity-0': !(models.hfToken && !models.hfTokenIsValid) }"
      >
        {{ languages.SETTINGS_MODEL_HUGGINGFACE_INVALID_TOKEN_TEXT }}
      </div>
    </div>
    <SettingsHeading sub>{{ languages.SETTINGS_MODEL_HUGGINGFACE_MIRROR_URL }}</SettingsHeading>
    <div class="flex flex-col items-start gap-2">
      <Input
        v-model="mirrorUrl"
        placeholder="https://huggingface.co"
        class="h-[30px] leading-[30px] rounded-md bg-card border-border text-foreground px-[3px]"
        :class="{ 'border-red-500': mirrorUrl && !isValidUrl(mirrorUrl) }"
      />
      <div class="flex gap-2 items-center">
        <Button
          variant="outline"
          size="sm"
          :disabled="!mirrorUrl || !isValidUrl(mirrorUrl)"
          @click="verifyMirror"
        >
          {{ languages.SETTINGS_MODEL_HUGGINGFACE_VERIFY }}
        </Button>
        <Button
          variant="default"
          size="sm"
          :disabled="!mirrorUrl || !isValidUrl(mirrorUrl)"
          @click="applyHfSettings"
        >
          {{ languages.SETTINGS_MODEL_HUGGINGFACE_APPLY }}
        </Button>
      </div>
      <div
        v-if="verificationMessage"
        class="text-xs"
        :class="verificationSuccess ? 'text-green-500' : 'text-yellow-600'"
      >
        {{ verificationMessage }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useModels } from '@/assets/js/store/models'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useDialogStore } from '@/assets/js/store/dialogs'
import { useI18N } from '@/assets/js/store/i18n'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import * as toast from '@/assets/js/toast'
import { createAppError } from '@/assets/js/errors/appError'
import { useErrors } from '@/assets/js/store/errors'

const models = useModels()
const backendServices = useBackendServices()
const dialogStore = useDialogStore()
const errors = useErrors()
const i18nState = useI18N().state
const languages = i18nState

const mirrorUrl = ref(models.hfEndpoint)
const verificationMessage = ref('')
const verificationSuccess = ref(false)

function isValidUrl(url: string): boolean {
  try {
    new URL(url)
    return true
  } catch {
    return false
  }
}

async function verifyMirror() {
  if (!mirrorUrl.value || !isValidUrl(mirrorUrl.value)) {
    return
  }

  verificationMessage.value = 'Verifying...'
  verificationSuccess.value = false

  try {
    const isValid = await models.verifyHfEndpoint(mirrorUrl.value)
    if (isValid.success) {
      verificationMessage.value = i18nState.SETTINGS_MODEL_HUGGINGFACE_VERIFICATION_SUCCESS
      verificationSuccess.value = true
    } else {
      verificationMessage.value = i18nState.SETTINGS_MODEL_HUGGINGFACE_VERIFICATION_FAILED.replace(
        '{error}',
        'Verification failed',
      )
      verificationSuccess.value = false
    }
  } catch (error: unknown) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error'
    verificationMessage.value = i18nState.SETTINGS_MODEL_HUGGINGFACE_VERIFICATION_FAILED.replace(
      '{error}',
      errorMessage,
    )
    verificationSuccess.value = false
  }
}

async function applyHfSettings() {
  if (!mirrorUrl.value || !isValidUrl(mirrorUrl.value)) {
    return
  }

  let userConfirmed = false
  dialogStore.showWarningDialog(i18nState.SETTINGS_MODEL_HUGGINGFACE_APPLY_CONFIRM, () => {
    userConfirmed = true
  })

  return new Promise<void>((resolve) => {
    const checkDialog = setInterval(() => {
      if (!dialogStore.warningDialogVisible) {
        clearInterval(checkDialog)
        if (userConfirmed) {
          executeRestartBackends().then(resolve)
        } else {
          resolve()
        }
      }
    }, 100)
  })
}

async function executeRestartBackends() {
  try {
    await models.updateHfEndpoint(mirrorUrl.value)

    const servicesToRestart = ['ai-backend', 'comfyui-backend'] as const

    // Stop all running services, using the return value (not reactive state) to track success
    const stopResults = await Promise.all(
      servicesToRestart.map(async (serviceName) => {
        const serviceInfo = backendServices.info.find((s) => s.serviceName === serviceName)
        if (serviceInfo?.status === 'running') {
          const status = await backendServices.stopService(serviceName)
          return { serviceName, status }
        }
        return { serviceName, status: 'stopped' as BackendStatus }
      }),
    )

    const allStopped = stopResults.every((r) => r.status === 'stopped')
    if (!allStopped) {
      reportRestartFailure('Failed to stop one or more backends')
      return
    }

    // Start all services, using the return value to track success
    const startResults = await Promise.all(
      servicesToRestart.map(async (serviceName) => {
        const status = await backendServices.startService(serviceName)
        return { serviceName, status }
      }),
    )

    const allRunning = startResults.every((r) => r.status === 'running')
    if (allRunning) {
      toast.success(i18nState.SETTINGS_MODEL_HUGGINGFACE_APPLY_SUCCESS)
    } else {
      reportRestartFailure('Failed to restart one or more backends')
    }
  } catch (error: unknown) {
    errors.report(error, {
      category: 'backend',
      code: 'settings/hf-endpoint-apply-failed',
      surface: 'toast',
    })
  }
}

function reportRestartFailure(message: string) {
  errors.report(
    createAppError({
      category: 'backend',
      code: 'settings/hf-endpoint-restart-failed',
      surface: 'toast',
      userMessage: message,
    }),
  )
}
</script>
