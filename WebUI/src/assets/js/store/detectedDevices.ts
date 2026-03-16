import { defineStore, acceptHMRUpdate } from 'pinia'
import { ref } from 'vue'

export type DetectedDeviceKind = 'intel' | 'nvidia' | 'apple-silicon' | 'gpu'

export type DetectedDevice = {
  id: string
  name: string
  kind: DetectedDeviceKind
}

export type GlobalDetectionResult = {
  devices: DetectedDevice[]
  detectedAt: string
}

export const useDetectedDevices = defineStore(
  'detectedDevices',
  () => {
    const detectionResult = ref<GlobalDetectionResult | null>(null)

    function setDetectionResult(result: GlobalDetectionResult) {
      detectionResult.value = result
    }

    // Fetch whatever the main process already has (e.g. from a previous run
    // before the frontend was ready to receive the push event).
    window.electronAPI.getGlobalDetectionResult().then((result) => {
      if (result) {
        detectionResult.value = result
      }
    })

    // Subscribe to live detection results pushed by the main process.
    window.electronAPI.onGlobalDetectionResult((result) => {
      detectionResult.value = result
    })

    return {
      detectionResult,
      setDetectionResult,
    }
  },
  { persist: true },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useDetectedDevices, import.meta.hot))
}
