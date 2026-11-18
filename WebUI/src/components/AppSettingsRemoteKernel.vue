<template>
  <div class="flex flex-col gap-3">
    <SettingsHeading>{{ languages.SETTINGS_REMOTE_KERNEL }}</SettingsHeading>
    <p class="text-xs text-muted-foreground">{{ languages.SETTINGS_REMOTE_KERNEL_INFO }}</p>

    <p
      v-if="statusLine"
      role="status"
      class="text-xs"
      :class="statusTone === 'ok' ? 'text-success' : 'text-warning'"
    >
      {{ statusLine }}
    </p>

    <AppSettingsRow :label="languages.SETTINGS_REMOTE_KERNEL_MODE" wide>
      <RadioGroup
        v-model="mode"
        class="flex flex-col gap-2"
        :aria-label="languages.SETTINGS_REMOTE_KERNEL_MODE"
      >
        <div v-for="option in modeOptions" :key="option.value" class="flex items-center gap-2">
          <RadioGroupItem :id="`remote-kernel-${option.value}`" :value="option.value" />
          <Label :for="`remote-kernel-${option.value}`" class="font-normal">
            {{ option.label }}
          </Label>
        </div>
      </RadioGroup>
    </AppSettingsRow>

    <template v-if="mode === 'host'">
      <AppSettingsRow v-slot="{ id }" :label="languages.SETTINGS_REMOTE_KERNEL_PORT">
        <Input :id="id" v-model.number="hostPort" type="number" class="h-[30px] w-28" />
      </AppSettingsRow>
      <AppSettingsRow
        :label="languages.SETTINGS_REMOTE_KERNEL_TOKEN"
        :description="languages.SETTINGS_REMOTE_KERNEL_HOST_TOKEN_INFO"
        wide
      >
        <template #default="{ id, describedBy }">
          <div class="flex items-center gap-2">
            <Input
              :id="id"
              :aria-describedby="describedBy"
              :model-value="hostToken || languages.SETTINGS_REMOTE_KERNEL_TOKEN_AFTER_SAVE"
              readonly
              class="h-[30px] flex-1 font-mono text-xs"
            />
            <Button variant="outline" size="sm" :disabled="!hostToken" @click="copyToken">
              {{ languages.SETTINGS_REMOTE_KERNEL_COPY }}
            </Button>
            <Button variant="outline" size="sm" :disabled="!hostToken" @click="regenerateToken">
              {{ languages.SETTINGS_REMOTE_KERNEL_REGENERATE }}
            </Button>
          </div>
        </template>
      </AppSettingsRow>
      <p v-if="status?.hostAddresses.length" class="text-xs text-muted-foreground">
        {{ languages.SETTINGS_REMOTE_KERNEL_HOST_ADDRESSES }}
        <span class="font-mono">{{ hostAddressList }}</span>
      </p>
    </template>

    <template v-if="mode === 'client'">
      <AppSettingsRow v-slot="{ id }" :label="languages.SETTINGS_REMOTE_KERNEL_CLIENT_HOST" wide>
        <Input :id="id" v-model="clientHost" placeholder="192.168.1.20" class="h-[30px]" />
      </AppSettingsRow>
      <AppSettingsRow v-slot="{ id }" :label="languages.SETTINGS_REMOTE_KERNEL_PORT">
        <Input :id="id" v-model.number="clientPort" type="number" class="h-[30px] w-28" />
      </AppSettingsRow>
      <AppSettingsRow v-slot="{ id }" :label="languages.SETTINGS_REMOTE_KERNEL_TOKEN" wide>
        <Input
          :id="id"
          v-model="clientToken"
          type="password"
          :placeholder="status?.clientHasToken ? languages.SETTINGS_REMOTE_KERNEL_TOKEN_STORED : ''"
          class="h-[30px]"
        />
      </AppSettingsRow>
      <div class="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          :disabled="!clientHost || !clientToken || testing"
          @click="testConnection"
        >
          {{ languages.SETTINGS_REMOTE_KERNEL_TEST }}
        </Button>
        <span
          v-if="testMessage"
          class="text-xs"
          :class="testOk ? 'text-success' : 'text-warning'"
          role="status"
        >
          {{ testMessage }}
        </span>
      </div>
    </template>

    <div class="flex items-center gap-3">
      <Button size="sm" :disabled="!canSave" @click="saveAndRestart">
        {{ languages.SETTINGS_REMOTE_KERNEL_SAVE_RESTART }}
      </Button>
      <span class="text-xs text-muted-foreground">
        {{ languages.SETTINGS_REMOTE_KERNEL_RESTART_NOTE }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useErrors } from '@/assets/js/store/errors'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import * as toast from '@/assets/js/toast'
import type { RemoteKernelMode, RemoteKernelStatus } from '@/types/remoteKernelIpc'

const languages = useI18N().state
const errors = useErrors()

const status = ref<RemoteKernelStatus | null>(null)
const mode = ref<RemoteKernelMode>('off')
const hostPort = ref(47800)
const clientHost = ref('')
const clientPort = ref(47800)
const clientToken = ref('')
const testing = ref(false)
const testOk = ref(false)
const testMessage = ref('')

const modeOptions = computed(() => [
  { value: 'off' as const, label: languages.SETTINGS_REMOTE_KERNEL_MODE_OFF },
  { value: 'host' as const, label: languages.SETTINGS_REMOTE_KERNEL_MODE_HOST },
  { value: 'client' as const, label: languages.SETTINGS_REMOTE_KERNEL_MODE_CLIENT },
])

const hostToken = computed(() => status.value?.hostToken ?? '')
const hostAddressList = computed(
  () => status.value?.hostAddresses.map((address) => `${address}:${hostPort.value}`).join(', ') ?? '',
)

const statusTone = computed(() =>
  status.value?.activeMode === 'client' && status.value.connection !== 'connected' ? 'warn' : 'ok',
)
const statusLine = computed(() => {
  const s = status.value
  if (!s) return ''
  if (s.activeMode === 'host') {
    return languages.SETTINGS_REMOTE_KERNEL_STATUS_HOST.replace('{port}', String(s.hostPort)).replace(
      '{count}',
      String(s.hostPeers),
    )
  }
  if (s.activeMode !== 'client') return ''
  if (s.connection === 'connected') {
    return languages.SETTINGS_REMOTE_KERNEL_STATUS_CONNECTED.replace(
      '{hostname}',
      s.remoteHostname ?? s.clientHost,
    )
  }
  if (s.connection === 'connecting') return languages.SETTINGS_REMOTE_KERNEL_STATUS_CONNECTING
  return languages.SETTINGS_REMOTE_KERNEL_STATUS_DISCONNECTED.replace(
    '{error}',
    s.lastError ?? '',
  )
})

const canSave = computed(() => {
  if (mode.value === 'host') return validPort(hostPort.value)
  if (mode.value === 'client') {
    return (
      !!clientHost.value.trim() &&
      validPort(clientPort.value) &&
      (!!clientToken.value || !!status.value?.clientHasToken)
    )
  }
  return true
})

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536
}

async function refresh() {
  status.value = await window.electronAPI.remoteKernel.getStatus()
}

let poll: ReturnType<typeof setInterval> | undefined

onMounted(async () => {
  await refresh()
  const s = status.value
  if (s) {
    mode.value = s.configuredMode
    hostPort.value = s.hostPort
    clientHost.value = s.clientHost
    clientPort.value = s.clientPort
  }
  poll = setInterval(() => void refresh(), 3000)
})

onUnmounted(() => clearInterval(poll))

async function copyToken() {
  await navigator.clipboard.writeText(hostToken.value)
  toast.success(languages.SETTINGS_REMOTE_KERNEL_TOKEN_COPIED)
}

async function regenerateToken() {
  await window.electronAPI.remoteKernel.regenerateToken()
  await refresh()
}

async function testConnection() {
  testing.value = true
  testMessage.value = ''
  try {
    const result = await window.electronAPI.remoteKernel.testConnection({
      host: clientHost.value.trim(),
      port: clientPort.value,
      token: clientToken.value.trim(),
    })
    testOk.value = result.success
    testMessage.value = result.success
      ? languages.SETTINGS_REMOTE_KERNEL_TEST_OK.replace('{hostname}', result.hostname)
      : languages.SETTINGS_REMOTE_KERNEL_TEST_FAILED.replace('{error}', result.error)
  } finally {
    testing.value = false
  }
}

async function saveAndRestart() {
  try {
    const result = await window.electronAPI.remoteKernel.saveConfig({
      mode: mode.value,
      hostPort: hostPort.value,
      clientHost: clientHost.value,
      clientPort: clientPort.value,
      ...(clientToken.value ? { clientToken: clientToken.value } : {}),
    })
    if (!result.success) throw new Error(result.error)
    await window.electronAPI.lifecycle.restart()
  } catch (error) {
    errors.report(error, {
      category: 'backend',
      code: 'settings/remote-kernel-save-failed',
      surface: 'toast',
    })
  }
}
</script>
