import { acceptHMRUpdate, defineStore } from 'pinia'
import { ref, computed } from 'vue'

export const useCamera = defineStore('camera', () => {
  const isStreaming = ref(false)
  const error = ref<string | null>(null)
  const capturedImage = ref<string | null>(null)

  let stream: MediaStream | null = null
  let videoElement: HTMLVideoElement | null = null

  const canCapture = computed(() => isStreaming.value && !error.value)

  async function startStream(video?: HTMLVideoElement) {
    if (isStreaming.value) return

    try {
      error.value = null
      capturedImage.value = null

      stream = await navigator.mediaDevices.getUserMedia({ video: true })

      if (video) {
        videoElement = video
        videoElement.srcObject = stream
        await videoElement.play()
      }

      isStreaming.value = true
    } catch (err) {
      console.error('Failed to start camera stream:', err)
      error.value = err instanceof Error ? err.message : 'Failed to start camera stream'
    }
  }

  function stopStream() {
    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop()
      }
      stream = null
    }

    if (videoElement) {
      videoElement.srcObject = null
      videoElement = null
    }

    isStreaming.value = false
  }

  function captureImage(): string | null {
    if (!isStreaming.value || !videoElement) {
      error.value = 'Camera is not streaming'
      return null
    }

    const canvas = document.createElement('canvas')
    canvas.width = videoElement.videoWidth
    canvas.height = videoElement.videoHeight

    const ctx = canvas.getContext('2d')
    if (!ctx) {
      error.value = 'Failed to get canvas context'
      return null
    }

    ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height)
    capturedImage.value = canvas.toDataURL('image/png')
    return capturedImage.value
  }

  return {
    isStreaming,
    error,
    capturedImage,
    canCapture,
    startStream,
    stopStream,
    captureImage,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useCamera, import.meta.hot))
}
