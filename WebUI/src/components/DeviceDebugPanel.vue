<script setup lang="ts">
import { computed, ref } from 'vue'
import { Button } from '@/components/ui/button'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { useErrors } from '@/assets/js/store/errors'
import { diffDeviceSnapshots, type DeviceDebugDiff } from '@/lib/deviceListDiff'
import type { DeviceDebugSnapshot } from '@/types/deviceDebug'

const BASELINE_KEY = 'aipg.deviceDebug.baseline'
const CURRENT_KEY = 'aipg.deviceDebug.current'

const errors = useErrors()
const current = ref<DeviceDebugSnapshot | null>(read(CURRENT_KEY))
const baseline = ref<DeviceDebugSnapshot | null>(read(BASELINE_KEY))
const probing = ref(false)
const probeError = ref<string | null>(null)
const collapsed = ref(false)

const diff = computed<DeviceDebugDiff | null>(() =>
  baseline.value && current.value ? diffDeviceSnapshots(baseline.value, current.value) : null,
)

const backendNames = computed(() => Object.keys(current.value?.backends ?? {}).sort())

function read(key: string): DeviceDebugSnapshot | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as DeviceDebugSnapshot) : null
  } catch {
    return null
  }
}

function write(key: string, snapshot: DeviceDebugSnapshot | null): void {
  try {
    if (snapshot) localStorage.setItem(key, JSON.stringify(snapshot))
    else localStorage.removeItem(key)
  } catch {
    // Quota or disabled storage is not worth failing a debug panel over.
  }
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString()
}

async function probe() {
  probing.value = true
  probeError.value = null
  try {
    const snapshot = await window.electronAPI.deviceDebug.probe()
    current.value = snapshot
    write(CURRENT_KEY, snapshot)
    if (!baseline.value) {
      baseline.value = snapshot
      write(BASELINE_KEY, snapshot)
    }
  } catch (e) {
    probeError.value = String(e)
    errors.report(e, { surface: 'silent' })
  } finally {
    probing.value = false
  }
}

function useAsBaseline() {
  baseline.value = current.value
  write(BASELINE_KEY, current.value)
}

function clearBaseline() {
  baseline.value = null
  write(BASELINE_KEY, null)
}

function selectedId(serviceName: string): string | undefined {
  return current.value?.persisted.lastSelectedDevicePerBackend[serviceName]
}
</script>

<template>
  <div
    class="fixed bottom-14 right-4 z-40 w-[24rem] max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-background/95 p-3 shadow-lg"
  >
    <div class="flex items-center justify-between gap-2">
      <SettingsHeading>Device list debug</SettingsHeading>
      <button
        type="button"
        class="text-xs text-muted-foreground hover:text-foreground"
        @click="collapsed = !collapsed"
      >
        {{ collapsed ? 'expand' : 'collapse' }}
      </button>
    </div>
    <div v-show="!collapsed" class="flex flex-col gap-3 pt-2">
      <p class="text-xs text-muted-foreground">
        Read-only probe of the GPU lists used for inference. Capture a baseline once, then probe
        later to see whether the OS enumeration changed under a persisted device selection.
      </p>
      <div class="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" :disabled="probing" @click="probe">
          {{ probing ? 'Probing…' : 'Probe fresh lists' }}
        </Button>
        <Button variant="ghost" size="sm" :disabled="!current" @click="useAsBaseline">
          Use current as baseline
        </Button>
        <Button variant="ghost" size="sm" :disabled="!baseline" @click="clearBaseline">
          Clear baseline
        </Button>
      </div>
      <p v-if="probing" class="text-xs text-muted-foreground">
        Probing the OpenVINO/torch backends can take up to 30 seconds.
      </p>
      <p v-if="probeError" class="text-xs text-destructive">{{ probeError }}</p>
      <p v-if="current" class="text-xs text-muted-foreground">
        Captured {{ formatTime(current.capturedAt) }} · {{ current.platform }}
        <span v-if="baseline"> · baseline {{ formatTime(baseline.capturedAt) }}</span>
        <span v-else> · no baseline yet</span>
      </p>

      <template v-if="current">
        <div class="rounded-lg border border-border p-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold">OS / GPU probe</span>
            <span
              v-if="diff"
              class="text-[10px] font-semibold uppercase"
              :class="diff.hardware.changed ? 'text-destructive' : 'text-success'"
            >
              {{ diff.hardware.changed ? 'changed' : 'unchanged' }}
            </span>
          </div>
          <p class="text-[11px] text-muted-foreground pb-2">
            detectGpuHardwareDevices + classifyDetectedDevices
          </p>
          <ul class="flex flex-col gap-0.5 font-mono text-[11px]">
            <li v-for="entry in current.hardware" :key="`${entry.device}-${entry.name}`">
              {{ entry.device }} · {{ entry.name }}
              <span v-if="entry.gpuDeviceId"> · {{ entry.gpuDeviceId }}</span>
              <span v-if="entry.uuid"> · uuid {{ entry.uuid }}</span>
              <span> · {{ entry.category }}</span>
            </li>
          </ul>
          <p v-if="diff?.hardware.removed.length" class="text-[11px] text-warning pt-1">
            Removed since baseline: {{ diff.hardware.removed.join(', ') }}
          </p>
          <p v-if="diff?.hardware.added.length" class="text-[11px] text-warning">
            Added since baseline: {{ diff.hardware.added.join(', ') }}
          </p>
          <ul v-if="diff?.hardware.reordered.length" class="text-[11px] text-destructive">
            <li v-for="row in diff.hardware.reordered" :key="row.position">
              position {{ row.position }}: {{ row.before }} → {{ row.after }}
            </li>
          </ul>
        </div>

        <div v-for="name in backendNames" :key="name" class="rounded-lg border border-border p-3">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold">{{ name }}</span>
            <div class="flex items-center gap-2">
              <span
                v-if="!current.backends[name].reProbed"
                class="text-[10px] font-semibold uppercase text-warning"
              >
                applied list
              </span>
              <span
                v-if="diff"
                class="text-[10px] font-semibold uppercase"
                :class="diff.backends[name].changed ? 'text-destructive' : 'text-success'"
              >
                {{ diff.backends[name].changed ? 'changed' : 'unchanged' }}
              </span>
            </div>
          </div>
          <p class="text-[11px] text-muted-foreground pb-2">{{ current.backends[name].source }}</p>
          <p v-if="current.backends[name].error" class="text-[11px] text-destructive pb-1">
            {{ current.backends[name].error }}
          </p>
          <ul class="flex flex-col gap-0.5 font-mono text-[11px]">
            <li
              v-for="entry in current.backends[name].devices"
              :key="entry.id"
              :class="entry.selected ? 'font-semibold' : ''"
            >
              {{ entry.selected ? '✓ ' : '' }}[{{ entry.id }}] {{ entry.name }}
              <span v-if="entry.uuid" class="font-normal text-muted-foreground">
                · uuid {{ entry.uuid }}
              </span>
            </li>
          </ul>
          <p v-if="selectedId(name)" class="text-[11px] text-muted-foreground pt-1">
            persisted selection: id "{{ selectedId(name) }}"
            <span v-if="current.persisted.lastSelectedDeviceUuidPerBackend[name]">
              · uuid {{ current.persisted.lastSelectedDeviceUuidPerBackend[name] }}
            </span>
          </p>
          <p v-if="diff?.backends[name]?.removed.length" class="text-[11px] text-warning pt-1">
            Removed since baseline: {{ diff.backends[name].removed.join(', ') }}
          </p>
          <p v-if="diff?.backends[name]?.added.length" class="text-[11px] text-warning">
            Added since baseline: {{ diff.backends[name].added.join(', ') }}
          </p>
          <ul v-if="diff?.backends[name]?.reordered.length" class="text-[11px] text-destructive">
            <li v-for="row in diff.backends[name].reordered" :key="row.position">
              position {{ row.position }}: {{ row.before }} → {{ row.after }}
            </li>
          </ul>
        </div>

        <div v-if="diff && diff.selections.length" class="rounded-lg border border-border p-3">
          <span class="text-xs font-semibold">Selection drift</span>
          <ul class="flex flex-col gap-1.5 pt-2 text-[11px]">
            <li v-for="selection in diff.selections" :key="selection.key">
              <span class="font-mono">{{ selection.key }}</span>
              — persisted id "{{ selection.persistedId }}"
              <span v-if="selection.persistedUuid"> (uuid {{ selection.persistedUuid }})</span>
              <span
                class="font-semibold uppercase"
                :class="selection.kind === 'same' ? 'text-success' : 'text-destructive'"
              >
                {{ selection.kind }}
              </span>
              <br />
              <span class="text-muted-foreground">
                baseline: {{ selection.beforeId ?? '—' }} · {{ selection.beforeName ?? '—' }} → now:
                {{ selection.afterId ?? '—' }} · {{ selection.afterName ?? '—' }}
              </span>
            </li>
          </ul>
        </div>
      </template>
    </div>
  </div>
</template>
