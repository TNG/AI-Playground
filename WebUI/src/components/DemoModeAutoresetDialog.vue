<template>
  <Dialog :open="true">
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Session Timeout</DialogTitle>
        <DialogDescription>
          The session will reset due to inactivity. Continue to stay in the current session?
        </DialogDescription>
      </DialogHeader>
      <DialogFooter>
        <Button variant="ghost" @click="cancel">No</Button>
        <Button @click="confirm">Yes ({{ countdown }})</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { ref, onMounted, onUnmounted } from 'vue'

const demoMode = useDemoMode()

const COUNTDOWN_SECONDS = 10

const countdown = ref(COUNTDOWN_SECONDS)
let countdownInterval: ReturnType<typeof setInterval> | null = null

onMounted(() => {
  countdownInterval = setInterval(() => {
    countdown.value--
    if (countdown.value <= 0) {
      confirm()
    }
  }, 1000)
})

onUnmounted(() => {
  if (countdownInterval) {
    clearInterval(countdownInterval)
    countdownInterval = null
  }
})

function confirm() {
  demoMode.resetDemo()
}

function cancel() {
  demoMode.cancelReset()
}
</script>
