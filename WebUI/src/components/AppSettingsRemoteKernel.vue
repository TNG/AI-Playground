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

      <template v-if="status?.activeMode === 'host'">
        <p v-if="status.hostAddresses.length" class="text-xs text-muted-foreground">
          {{ languages.SETTINGS_REMOTE_KERNEL_HOST_ADDRESSES }}
          <span class="font-mono">{{ hostAddressList }}</span>
        </p>
        <p v-if="status.hostFingerprint" class="text-xs text-muted-foreground">
          {{ languages.SETTINGS_REMOTE_KERNEL_FINGERPRINT }}
          <span class="font-mono break-all">{{ formatFingerprint(status.hostFingerprint) }}</span>
        </p>

        <div
          v-if="status.pairing"
          role="group"
          :aria-label="languages.SETTINGS_REMOTE_KERNEL_CODE"
          class="flex items-center gap-4 rounded-md border border-border bg-muted/30 p-3"
        >
          <span class="font-mono text-3xl tracking-[0.4em]">{{ status.pairing.code }}</span>
          <span class="flex-1 text-xs text-muted-foreground">
            {{
              languages.SETTINGS_REMOTE_KERNEL_PAIRING_CODE_INFO.replace(
                '{seconds}',
                String(secondsLeft),
              )
            }}
          </span>
          <Button variant="outline" size="sm" @click="closePairing">
            {{ languages.SETTINGS_REMOTE_KERNEL_PAIRING_CANCEL }}
          </Button>
        </div>
        <div v-else>
          <Button size="sm" @click="openPairing">
            {{ languages.SETTINGS_REMOTE_KERNEL_PAIR_DEVICE }}
          </Button>
        </div>

        <div class="flex flex-col gap-1">
          <SettingsHeading sub>{{ languages.SETTINGS_REMOTE_KERNEL_DEVICES }}</SettingsHeading>
          <p v-if="!status.devices.length" class="text-xs text-muted-foreground">
            {{ languages.SETTINGS_REMOTE_KERNEL_DEVICES_EMPTY }}
          </p>
          <ul v-else class="flex flex-col gap-1">
            <li
              v-for="device in status.devices"
              :key="device.id"
              class="flex items-center gap-2 text-sm"
            >
              <span class="flex-1 truncate">{{ device.name }}</span>
              <span class="text-xs text-muted-foreground">
                {{
                  device.lastSeenAt
                    ? languages.SETTINGS_REMOTE_KERNEL_DEVICE_LAST_SEEN.replace(
                        '{time}',
                        formatTime(device.lastSeenAt),
                      )
                    : languages.SETTINGS_REMOTE_KERNEL_DEVICE_NEVER_SEEN
                }}
              </span>
              <Button
                variant="outline"
                size="sm"
                :aria-label="`${languages.SETTINGS_REMOTE_KERNEL_REVOKE} ${device.name}`"
                @click="revokeDevice(device.id)"
              >
                {{ languages.SETTINGS_REMOTE_KERNEL_REVOKE }}
              </Button>
            </li>
          </ul>
        </div>
        <AppSettingsRow
          :label="languages.SETTINGS_REMOTE_KERNEL_RESET_PAIRING"
          :description="languages.SETTINGS_REMOTE_KERNEL_RESET_PAIRING_INFO"
        >
          <Button variant="outline" size="sm" @click="resetPairing">
            {{ languages.SETTINGS_REMOTE_KERNEL_RESET_PAIRING }}
          </Button>
        </AppSettingsRow>
      </template>
      <p v-else class="text-xs text-muted-foreground">
        {{ languages.SETTINGS_REMOTE_KERNEL_PAIRING_RESTART_FIRST }}
      </p>
    </template>

    <template v-if="mode === 'client'">
      <div
        v-if="status?.pairedHost"
        class="flex items-center gap-3 rounded-md border border-border bg-muted/30 p-3"
      >
        <span class="flex-1 text-sm">
          {{
            languages.SETTINGS_REMOTE_KERNEL_PAIRED_WITH.replace(
              '{hostname}',
              status.pairedHost.hostname,
            )
          }}
          <span class="block font-mono text-xs text-muted-foreground">
            {{ status.pairedHost.host }}:{{ status.pairedHost.port }} ·
            {{ formatFingerprint(status.pairedHost.fingerprint).slice(0, 23) }}…
          </span>
        </span>
        <Button variant="outline" size="sm" @click="forgetHost">
          {{ languages.SETTINGS_REMOTE_KERNEL_FORGET }}
        </Button>
      </div>

      <template v-else>
        <div class="flex flex-col gap-2">
          <div>
            <Button variant="outline" size="sm" :disabled="searching" @click="discover">
              {{
                searching
                  ? languages.SETTINGS_REMOTE_KERNEL_SEARCHING
                  : languages.SETTINGS_REMOTE_KERNEL_SEARCH
              }}
            </Button>
          </div>
          <p v-if="searched && !discovered.length" class="text-xs text-muted-foreground">
            {{ languages.SETTINGS_REMOTE_KERNEL_SEARCH_EMPTY }}
          </p>
          <ul
            v-if="discovered.length"
            class="flex flex-col gap-1"
            :aria-label="languages.SETTINGS_REMOTE_KERNEL_DISCOVERED"
          >
            <li
              v-for="found in discovered"
              :key="`${found.addresses[0]}:${found.port}`"
              class="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm"
            >
              <span class="flex-1 truncate">
                {{ found.name }}
                <span class="font-mono text-xs text-muted-foreground">
                  {{ found.addresses[0] }}:{{ found.port }} ·
                  {{ formatFingerprint(found.fingerprintHint) }}
                </span>
              </span>
              <span
                v-if="found.pairingOpen"
                class="rounded bg-primary/15 px-1.5 py-0.5 text-xs text-foreground"
              >
                {{ languages.SETTINGS_REMOTE_KERNEL_PAIRING_OPEN }}
              </span>
              <Button
                variant="outline"
                size="sm"
                :aria-label="`${languages.SETTINGS_REMOTE_KERNEL_USE_HOST} ${found.name}`"
                @click="useHost(found)"
              >
                {{ languages.SETTINGS_REMOTE_KERNEL_USE_HOST }}
              </Button>
            </li>
          </ul>
        </div>

        <AppSettingsRow v-slot="{ id }" :label="languages.SETTINGS_REMOTE_KERNEL_CLIENT_HOST" wide>
          <Input :id="id" v-model="clientHost" placeholder="192.168.1.20" class="h-[30px]" />
        </AppSettingsRow>
        <AppSettingsRow v-slot="{ id }" :label="languages.SETTINGS_REMOTE_KERNEL_PORT">
          <Input :id="id" v-model.number="clientPort" type="number" class="h-[30px] w-28" />
        </AppSettingsRow>
        <AppSettingsRow v-slot="{ id }" :label="languages.SETTINGS_REMOTE_KERNEL_CODE">
          <Input
            :id="id"
            v-model="code"
            inputmode="numeric"
            maxlength="4"
            placeholder="0000"
            class="h-[30px] w-28 font-mono tracking-[0.3em]"
          />
        </AppSettingsRow>
        <div class="flex flex-wrap items-center gap-2">
          <Button size="sm" :disabled="!canPair || pairing" @click="pair">
            {{ languages.SETTINGS_REMOTE_KERNEL_PAIR }}
          </Button>
          <span
            v-if="pairMessage"
            class="text-xs"
            :class="pairOk ? 'text-success' : 'text-warning'"
            role="status"
          >
            {{ pairMessage }}
          </span>
        </div>
        <p class="text-xs text-muted-foreground">
          {{ languages.SETTINGS_REMOTE_KERNEL_CLIENT_NEEDS_PAIRING }}
        </p>
      </template>
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
import { createAppError } from '@/assets/js/errors/appError'
import type { DiscoveredHost, RemoteKernelMode, RemoteKernelStatus } from '@/types/remoteKernelIpc'

const languages = useI18N().state
const errors = useErrors()

const status = ref<RemoteKernelStatus | null>(null)
const mode = ref<RemoteKernelMode>('off')
const hostPort = ref(47800)
const clientHost = ref('')
const clientPort = ref(47800)
const code = ref('')
const pairing = ref(false)
const pairOk = ref(false)
const pairMessage = ref('')
const searching = ref(false)
const searched = ref(false)
const discovered = ref<DiscoveredHost[]>([])
const now = ref(Date.now())

const modeOptions = computed(() => [
  { value: 'off' as const, label: languages.SETTINGS_REMOTE_KERNEL_MODE_OFF },
  { value: 'host' as const, label: languages.SETTINGS_REMOTE_KERNEL_MODE_HOST },
  { value: 'client' as const, label: languages.SETTINGS_REMOTE_KERNEL_MODE_CLIENT },
])

const hostAddressList = computed(
  () =>
    status.value?.hostAddresses.map((address) => `${address}:${hostPort.value}`).join(', ') ?? '',
)
const secondsLeft = computed(() =>
  Math.max(0, Math.round(((status.value?.pairing?.expiresAt ?? 0) - now.value) / 1000)),
)

const statusTone = computed(() =>
  status.value?.configuredMode === 'client' && status.value.connection !== 'connected'
    ? 'warn'
    : 'ok',
)
const statusLine = computed(() => {
  const s = status.value
  if (!s) return ''
  if (s.activeMode === 'host') {
    return languages.SETTINGS_REMOTE_KERNEL_STATUS_HOST.replace(
      '{port}',
      String(s.hostPort),
    ).replace('{count}', String(s.hostPeers))
  }
  if (s.activeMode !== 'client') {
    return s.configuredMode === 'client' && s.lastError
      ? languages.SETTINGS_REMOTE_KERNEL_STATUS_DISCONNECTED.replace('{error}', s.lastError)
      : ''
  }
  if (s.connection === 'connected') {
    return languages.SETTINGS_REMOTE_KERNEL_STATUS_CONNECTED.replace(
      '{hostname}',
      s.remoteHostname ?? s.pairedHost?.hostname ?? '',
    )
  }
  if (s.connection === 'connecting') return languages.SETTINGS_REMOTE_KERNEL_STATUS_CONNECTING
  return languages.SETTINGS_REMOTE_KERNEL_STATUS_DISCONNECTED.replace('{error}', s.lastError ?? '')
})

const canPair = computed(
  () => !!clientHost.value.trim() && validPort(clientPort.value) && /^\d{4}$/.test(code.value),
)
const canSave = computed(() => {
  if (mode.value === 'host') return validPort(hostPort.value)
  if (mode.value === 'client') return !!status.value?.pairedHost
  return true
})

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port < 65536
}

function formatFingerprint(hex: string): string {
  return (hex.toUpperCase().match(/.{1,2}/g) ?? []).join(':')
}

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString()
}

function reportFailure(error: unknown, code: string) {
  errors.report(error, { category: 'backend', code, surface: 'toast' })
}

function reportMessage(message: string, code: string) {
  errors.report(
    createAppError({ category: 'backend', code, surface: 'toast', userMessage: message }),
  )
}

async function refresh() {
  status.value = await window.electronAPI.remoteKernel.getStatus()
}

let poll: ReturnType<typeof setInterval> | undefined
let clock: ReturnType<typeof setInterval> | undefined

onMounted(async () => {
  await refresh()
  const s = status.value
  if (s) {
    mode.value = s.configuredMode
    hostPort.value = s.hostPort
  }
  poll = setInterval(() => void refresh(), 2000)
  clock = setInterval(() => (now.value = Date.now()), 1000)
})

onUnmounted(() => {
  clearInterval(poll)
  clearInterval(clock)
})

async function openPairing() {
  const result = await window.electronAPI.remoteKernel.openPairing()
  if (!result.success) reportMessage(result.error, 'settings/remote-kernel-pairing-failed')
  await refresh()
}

async function closePairing() {
  await window.electronAPI.remoteKernel.closePairing()
  await refresh()
}

async function revokeDevice(id: string) {
  const result = await window.electronAPI.remoteKernel.revokeDevice(id)
  if (!result.success) reportMessage(result.error, 'settings/remote-kernel-revoke-failed')
  await refresh()
}

async function resetPairing() {
  const result = await window.electronAPI.remoteKernel.resetPairing()
  if (!result.success) reportMessage(result.error, 'settings/remote-kernel-reset-failed')
  await refresh()
}

async function discover() {
  searching.value = true
  try {
    const result = await window.electronAPI.remoteKernel.discover()
    if (!result.success) throw new Error(result.error)
    discovered.value = result.data
    searched.value = true
  } catch (error) {
    reportFailure(error, 'settings/remote-kernel-discover-failed')
  } finally {
    searching.value = false
  }
}

function useHost(found: DiscoveredHost) {
  clientHost.value = found.addresses[0]
  clientPort.value = found.port
}

async function pair() {
  pairing.value = true
  pairMessage.value = ''
  try {
    const result = await window.electronAPI.remoteKernel.pair({
      host: clientHost.value.trim(),
      port: clientPort.value,
      code: code.value,
    })
    pairOk.value = result.success
    pairMessage.value = result.success
      ? languages.SETTINGS_REMOTE_KERNEL_PAIRED_WITH.replace('{hostname}', result.hostname)
      : languages.SETTINGS_REMOTE_KERNEL_PAIR_FAILED.replace('{error}', result.error)
    if (result.success) code.value = ''
    await refresh()
  } finally {
    pairing.value = false
  }
}

async function forgetHost() {
  const result = await window.electronAPI.remoteKernel.forgetHost()
  if (!result.success) reportMessage(result.error, 'settings/remote-kernel-forget-failed')
  pairMessage.value = ''
  await refresh()
}

async function saveAndRestart() {
  try {
    const result = await window.electronAPI.remoteKernel.saveConfig({
      mode: mode.value,
      hostPort: hostPort.value,
    })
    if (!result.success) throw new Error(result.error)
    await window.electronAPI.lifecycle.restart()
  } catch (error) {
    reportFailure(error, 'settings/remote-kernel-save-failed')
  }
}
</script>
