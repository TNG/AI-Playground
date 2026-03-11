<template>
  <teleport to="body">
    <div v-if="isDemoModeOn" class="demo-mode-indicator">
      <p>Demo mode active.</p>
    </div>
  </teleport>
</template>

<script setup lang="ts">
import { useDemoMode } from '@/assets/js/store/demoMode'

const demoMode = useDemoMode()

const isDemoModeOn = demoMode.enabled
</script>

<style scoped>
.demo-mode-indicator {
  position: fixed;
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background-color: rgba(0, 0, 50, 0.85);
  border-radius: 10px;
  padding: 6px 20px;
  color: white;
  width: 600px;
  height: 40px;
  text-align: center;
}
</style>
