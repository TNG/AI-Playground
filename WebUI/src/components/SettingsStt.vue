<template>
  <div class="flex flex-col gap-4">
    <!-- Install guidance: Whisper needs OpenVINO; External needs an endpoint set up
         in App Settings. Shown when neither is usable. -->
    <p
      v-if="!openVinoSetUp && !speechToText.isExternalAvailable"
      class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
    >
      Install the OpenVINO backend from Settings → Installation Management to use Whisper, or enable
      an external transcription endpoint in App Settings → External speech endpoints.
    </p>

    <!-- Model row: pick the transcription engine. Whisper runs on OpenVINO; External
         uses the endpoint configured in App Settings. Both options are always shown. -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
      <drop-down-new
        title="Model"
        :value="speechToText.selectedSttEngine"
        :items="engineItems"
        @change="(v) => (speechToText.selectedSttEngine = v as SttEngine)"
      ></drop-down-new>
    </div>

    <!-- Hardware: which accelerator the Whisper model loads on (Whisper engine only). -->
    <div
      v-if="speechToText.selectedSttEngine === 'whisper' && openVinoSetUp && sttDevices.length > 0"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">{{ languages.SETTINGS_INFERENCE_DEVICE }}</Label>
      <drop-down-new
        title="STT Device"
        :value="selectedSttDevice?.id"
        :items="sttDeviceItems"
        @change="selectSttDevice"
      ></drop-down-new>
    </div>

    <!-- External endpoint config: enabled via the checkbox in App Settings; the
         endpoint itself is configured here. Any OpenAI-compatible transcription
         server (e.g. a local whisper.cpp whisper-server). -->
    <template v-if="speechToText.selectedSttEngine === 'external'">
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Base URL</Label>
        <Input v-model="speechToText.fallback.baseUrl" placeholder="http://127.0.0.1:2022/v1" />
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Model</Label>
        <Input v-model="speechToText.fallback.model" placeholder="whisper-1" />
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">API key</Label>
        <Input v-model="speechToText.fallback.apiKey" type="password" placeholder="(optional)" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import DropDownNew from '@/components/DropDownNew.vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useSpeechToText } from '@/assets/js/store/speechToText'
import type { SttEngine } from '@/assets/js/store/speechToText'
import { useProductMode } from '@/assets/js/store/productMode'
import { useBackendServices } from '@/assets/js/store/backendServices'

const languages = useI18N().state
const speechToText = useSpeechToText()
const productMode = useProductMode()
const backendServices = useBackendServices()

const openVinoSetUp = computed(
  () => backendServices.info.find((s) => s.serviceName === 'openvino-backend')?.isSetUp === true,
)

// Whisper (OpenVINO) is offered only in non-NVIDIA modes; External is always listed.
// The dot reflects usability (Whisper needs OVMS, External needs a configured endpoint).
const engineItems = computed(() => {
  const items: { label: string; value: string; active: boolean }[] = []
  if (!productMode.isNvidiaModeSelected) {
    items.push({
      label: 'Whisper (OpenVINO)',
      value: 'whisper',
      active: speechToText.isWhisperAvailable,
    })
  }
  items.push({
    label: 'External endpoint',
    value: 'external',
    active: speechToText.isExternalAvailable,
  })
  return items
})

// If the selected engine is no longer offered (e.g. Whisper after switching to NVIDIA
// mode), fall back to the first available option.
watch(
  engineItems,
  (items) => {
    if (!items.some((i) => i.value === speechToText.selectedSttEngine)) {
      speechToText.selectedSttEngine = items[0]?.value as SttEngine
    }
  },
  { immediate: true },
)

// STT device selection (Whisper loads on a dedicated OVMS device list, distinct
// from the LLM device list DeviceSelector uses). Mirrors the logic previously in
// SettingsBasic.vue.
const sttDevices = computed(
  () => backendServices.info.find((bs) => bs.serviceName === 'openvino-backend')?.sttDevices ?? [],
)
const selectedSttDevice = computed(
  () => sttDevices.value.find((d: InferenceDevice) => d.selected) ?? sttDevices.value[0],
)
const sttDeviceItems = computed(() =>
  sttDevices.value.map((d: InferenceDevice) => ({
    label: `${d.id}: ${d.name}`,
    value: d.id,
    active: true,
  })),
)

async function selectSttDevice(deviceId: string) {
  await backendServices.selectSttDevice('openvino-backend', deviceId)
}
</script>
