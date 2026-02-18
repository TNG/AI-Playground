<template>
  <div v-if="backendLoadingDialogVisible" class="dialog-container z-50">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/80 flex justify-center items-center"
    >
      <div
        class="py-10 px-20 w-500px flex flex-col items-center justify-center bg-card rounded-3xl gap-6 text-foreground shadow-2xl border border-border"
        :class="{ 'animate-scale-in': animate }"
      >
        <div class="flex flex-col items-center gap-4">
          <!-- Loading spinner -->
          <div class="relative w-16 h-16">
            <div class="absolute inset-0 border-4 border-primary/30 rounded-full"></div>
            <div class="absolute inset-0 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
          </div>

          <!-- Backend name and status -->
          <p class="text-center text-lg font-medium">
            {{ backendLoadingMessage }}
          </p>

          <!-- Subtitle message -->
          <p class="text-center text-sm text-muted-foreground">
            {{ i18nState.BACKEND_LOADING_MESSAGE }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useI18N } from '@/assets/js/store/i18n.ts'
import { useDialogStore } from '@/assets/js/store/dialogs.ts'
import { storeToRefs } from 'pinia'

const i18nState = useI18N().state
const dialogStore = useDialogStore()
const animate = ref(false)

const { backendLoadingDialogVisible, backendLoadingMessage } = storeToRefs(dialogStore)

watch(backendLoadingDialogVisible, (newValue) => {
  if (newValue) {
    animate.value = false
    nextTick(() => {
      animate.value = true
    })
  } else {
    animate.value = false
  }
})
</script>

<style scoped>
.animate-scale-in {
  animation: scale-in 0.2s ease-out;
}

@keyframes scale-in {
  from {
    transform: scale(0.95);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}
</style>

