<template>
  <button
    class="absolute bottom-65 left-1/2 transform -translate-x-1/2 bg-background text-foreground p-2 rounded-full shadow-lg z-50 hover:bg-muted transition-colors"
    title="Scroll to bottom"
    aria-label="Scroll to bottom"
  >
    <ArrowDownIcon class="w-4 h-4" />
  </button>
</template>

<script setup lang="ts">
import { ArrowDownIcon } from '@heroicons/vue/24/outline'
</script>
