<template>
  <template v-if="demoMode.enabled">
    <DemoModeNotificationDot
      v-for="mapping in buttonMappings"
      :key="mapping.buttonId"
      :button-id="mapping.buttonId"
      :target-id="mapping.targetId"
    />
  </template>
</template>

<script setup lang="ts">
import { useDemoMode, type DemoButtonId } from '@/assets/js/store/demoMode'
import DemoModeNotificationDot from '@/components/DemoModeNotificationDot.vue'

const demoMode = useDemoMode()

const buttonMappings: { buttonId: DemoButtonId; targetId: string }[] = [
  { buttonId: 'mode-chat', targetId: 'mode-button-chat' },
  { buttonId: 'mode-imageGen', targetId: 'mode-button-imageGen' },
  { buttonId: 'mode-imageEdit', targetId: 'mode-button-imageEdit' },
  { buttonId: 'mode-video', targetId: 'mode-button-video' },
  { buttonId: 'camera', targetId: 'camera-button' },
  { buttonId: 'microphone', targetId: 'microphone-button' },
  { buttonId: 'app-settings', targetId: 'app-settings-button' },
  { buttonId: 'advanced-settings', targetId: 'advanced-settings-button' },
  { buttonId: 'plus-icon', targetId: 'plus-icon' },
]
</script>
