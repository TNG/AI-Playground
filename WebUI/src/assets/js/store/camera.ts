import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed } from 'vue'

export type CameraDevice = {
  deviceId: string
  label: string
  kind: string
}

export const useCameraStore = defineStore('camera', () => {
  // State
  const devices = ref<CameraDevice[]>([])
  const selectedDeviceId = ref<string | null>(null)
  const stream = ref<MediaStream | null>(null)
  const error = ref<string | null>(null)
  const isLoading = ref(false)

  // Getters
  const hasDevices = computed(() => devices.value.length > 0)
  const isActive = computed(() => stream.value !== null)

  // Actions
  async function getDevices() {
    try {
      isLoading.value = true
      error.value = null

      // Request camera permission first
      const tempStream = await navigator.mediaDevices.getUserMedia({ video: true })
      tempStream.getTracks().forEach((track) => track.stop())

      const mediaDevices = await navigator.mediaDevices.enumerateDevices()
      const videoDevices = mediaDevices.filter((device) => device.kind === 'videoinput')

      devices.value = videoDevices.map((device, index) => ({
        deviceId: device.deviceId,
        label: device.label || `Camera ${index + 1}`,
        kind: device.kind,
      }))

      // Auto-select first device if none selected
      if (devices.value.length > 0 && !selectedDeviceId.value) {
        selectedDeviceId.value = devices.value[0].deviceId
        // Don't auto-start camera here - let the component decide when to start it
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to get camera devices'
      console.error('Error getting camera devices:', err)
    } finally {
      isLoading.value = false
    }
  }

  async function startCamera(deviceId?: string) {
    try {
      isLoading.value = true
      error.value = null

      const targetDeviceId = deviceId || selectedDeviceId.value

      if (!targetDeviceId) {
        throw new Error('No camera device selected')
      }

      // Stop existing stream if any
      if (stream.value) {
        stopCamera()
      }

      stream.value = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: targetDeviceId } },
      })

      selectedDeviceId.value = targetDeviceId
    } catch (err) {
      error.value = err instanceof Error ? err.message : 'Failed to start camera'
      console.error('Error starting camera:', err)
    } finally {
      isLoading.value = false
    }
  }

  function stopCamera() {
    if (stream.value) {
      stream.value.getTracks().forEach((track) => track.stop())
      stream.value = null
    }
  }

  function captureImage(video: HTMLVideoElement): string | null {
    if (!isActive.value || !stream.value) {
      error.value = 'Camera is not active'
      return null
    }

    const canvas = document.createElement('canvas')
    canvas.width = video.videoWidth
    canvas.height = video.videoHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      error.value = 'Failed to get canvas context'
      return null
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
    return canvas.toDataURL('image/png')
  }

  async function selectDevice(deviceId: string) {
    selectedDeviceId.value = deviceId
    await startCamera(deviceId)
  }

  function clearError() {
    error.value = null
  }

  return {
    devices,
    selectedDeviceId,
    stream,
    isActive,
    error,
    isLoading,
    hasDevices,
    getDevices,
    startCamera,
    stopCamera,
    captureImage,
    selectDevice,
    clearError,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCameraStore, import.meta.hot))
}
