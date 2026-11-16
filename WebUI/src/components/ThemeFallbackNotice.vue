<template>
  <p
    v-if="theme.fallbackMessage"
    role="status"
    class="flex items-start gap-2 rounded-md border border-warning/50 bg-warning/10 p-2 text-xs"
  >
    <ExclamationTriangleIcon class="size-4 shrink-0 text-warning" />
    {{ theme.fallbackMessage }}
  </p>
</template>

<script setup lang="ts">
import { ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import { useTheme } from '@/assets/js/store/theme'

const theme = useTheme()
</script>
