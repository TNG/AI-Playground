<template>
  <div class="flex flex-col gap-4">
    <!-- Controls Row -->
    <div class="flex items-center gap-4 flex-wrap">
      <!-- Device Selector -->
      <div v-if="cameraStore.hasDevices" class="flex items-center gap-2">
        <span class="text-sm text-muted-foreground">Camera:</span>
        <DropDownNew
          :items="deviceItems"
          :value="cameraStore.selectedDeviceId || ''"
          :on-change="onDeviceChange"
          :disabled="cameraStore.isLoading"
        />
      </div>

      <!-- Start/Stop Button -->
      <Button
        variant="outline"
        size="sm"
        :disabled="cameraStore.isLoading || !cameraStore.hasDevices"
        @click="toggleCamera"
      >
        <span v-if="cameraStore.isLoading">Loading...</span>
        <span v-else-if="cameraStore.isActive">Stop Camera</span>
        <span v-else>Start Camera</span>
      </Button>
    </div>

    <!-- Error Message -->
    <div
      v-if="cameraStore.error"
      class="flex items-center justify-between bg-destructive/10 border border-destructive/30 rounded-md px-4 py-2"
    >
      <span class="text-sm text-destructive">{{ cameraStore.error }}</span>
      <Button variant="ghost" size="sm" @click="cameraStore.clearError"> Dismiss </Button>
    </div>

    <!-- Camera View / Captured Image -->
    <div class="relative bg-card rounded-lg overflow-hidden border border-border">
      <!-- Captured Image Preview -->
      <div v-if="cameraStore.capturedImage" class="relative">
        <img
          :src="cameraStore.capturedImage"
          alt="Captured"
          class="w-full max-h-[400px] object-contain"
        />
        <Button variant="secondary" size="sm" class="absolute top-2 right-2" @click="clearCapture">
          Clear
        </Button>
      </div>

      <!-- Video Stream -->
      <template v-else>
        <video
          ref="videoElement"
          autoplay
          playsinline
          class="w-full max-h-[400px] bg-black"
          :class="{ 'opacity-0': !cameraStore.isActive }"
        ></video>

        <!-- Placeholder -->
        <div
          v-if="!cameraStore.isActive"
          class="absolute inset-0 flex flex-col items-center justify-center bg-muted/50"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            class="h-12 w-12 text-muted-foreground mb-2"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              stroke-linecap="round"
              stroke-linejoin="round"
              stroke-width="1.5"
              d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z"
            />
          </svg>
          <span class="text-sm text-muted-foreground">Click "Start Camera" to begin</span>
        </div>
      </template>
    </div>

    <!-- Capture Button -->
    <div v-if="cameraStore.isActive" class="flex justify-center">
      <Button variant="default" size="sm" @click="capture">Capture</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted, watch, computed } from 'vue'
import DropDownNew from './DropDownNew.vue'
import { Button } from '@/components/ui/button'
import { useCameraStore } from '@/assets/js/store/camera'

const cameraStore = useCameraStore()
const videoElement = ref<HTMLVideoElement | null>(null)

const emit = defineEmits<{
  capture: [file: File]
}>()

watch(
  () => cameraStore.stream,
  (newStream) => {
    if (videoElement.value && newStream) {
      videoElement.value.srcObject = newStream
    }
  },
)

onMounted(async () => {
  await cameraStore.getDevices()
  if (cameraStore.hasDevices && !cameraStore.isActive) {
    await cameraStore.startCamera(cameraStore.selectedDeviceId || undefined)
  }
})

onUnmounted(() => {
  cameraStore.stopCamera()
})

const deviceItems = computed(() =>
  cameraStore.devices.map((d) => ({
    label: d.label,
    value: d.deviceId,
    active: d.deviceId === cameraStore.selectedDeviceId,
  })),
)

async function toggleCamera() {
  if (cameraStore.isActive) {
    cameraStore.stopCamera()
  } else {
    await cameraStore.startCamera()
  }
}

async function onDeviceChange(deviceId: string) {
  cameraStore.selectDevice(deviceId)
  if (cameraStore.isActive) {
    await cameraStore.startCamera(deviceId)
  }
}

async function capture() {
  if (!videoElement.value) return
  const dataUrl = cameraStore.captureImage(videoElement.value)
  if (!dataUrl) return

  // Convert data URL to File
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  const file = new File([blob], 'camera-capture.png', { type: 'image/png' })

  emit('capture', file)
}

function clearCapture() {
  cameraStore.capturedImage = null
}
</script>
