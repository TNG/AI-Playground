<template>
  <div
    class="flex aspect-square max-w-full items-center justify-center overflow-hidden rounded-lg bg-accent"
    :style="{ width: `min(100%, ${ARTIFACT_CARD_PX}px)` }"
  >
    <img :src="src" :alt="alt" class="h-full w-full object-contain" />
  </div>
</template>

<script setup lang="ts">
import { ARTIFACT_CARD_PX } from '@/lib/turnArtifacts'

// A chat image letterboxed into the same fixed square box the generated-media cards use.
defineProps<{ src: string; alt: string }>()
</script>
