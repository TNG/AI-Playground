<script setup lang="ts">
import { CollapsibleContent, type CollapsibleContentProps } from 'radix-vue'

const props = defineProps<CollapsibleContentProps>()
</script>

<template>
  <!-- No height animation: Electron then leaves parts of the content (labels, status dots,
       input values) unpainted until the next interaction. -->
  <CollapsibleContent v-bind="props" class="overflow-hidden">
    <slot />
  </CollapsibleContent>
</template>
