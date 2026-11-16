<template>
  <div
    v-if="dialogStore.cameraDialogVisible"
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
  >
    <div class="bg-background rounded-lg p-6 w-full max-w-lg mx-4 shadow-xl">
      <h2 class="text-lg font-semibold mb-4">Capture Image</h2>
      <CameraCapture @capture="dialogStore.handleCameraCapture" />
      <div class="mt-4 flex justify-end">
        <Button variant="outline" @click="dialogStore.closeCameraDialog()">Close</Button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useDialogStore } from '@/assets/js/store/dialogs'
import CameraCapture from '@/components/CameraCapture.vue'
import Button from '@/components/ui/button/Button.vue'

const dialogStore = useDialogStore()
</script>
