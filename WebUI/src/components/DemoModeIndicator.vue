<template>
  <transition name="fade">
    <div class="demo-mode-indicator" v-if="isDemoModeOn">
      <div class="center-popup">
        <p>Demo mode active.</p>
      </div>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { useDemoMode } from '@/assets/js/store/demoMode'

const demoMode = useDemoMode()

const isDemoModeOn = demoMode.enabled
</script>

<style scoped>
/* sidebars should be able to overlap it */
.demo-mode-indicator {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 8;
}

.center-popup {
  position: absolute;
  top: 10px;
  left: 50%;
  transform: translateX(-50%);
  background-color: rgba(0, 0, 50, 0.85);
  /* border: 2px solid #00bfff; */
  /* box-shadow: 0px 0.75px 4.95px #00c4fa; */
  border-radius: 10px;
  padding: 16px 20px;
  color: white;
  width: 600px;
  height: 60px;
  text-align: center;
}
</style>
