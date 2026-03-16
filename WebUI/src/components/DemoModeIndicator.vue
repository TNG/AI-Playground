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
  background-color: color-mix(in srgb, var(--demo-indicator-bg) 85%, transparent);
  border-radius: 10px;
  padding: 6px 20px;
  color: var(--demo-text-color);
  width: 600px;
  height: 40px;
  text-align: center;
}
</style>
