<template>
  <div class="flex min-w-0 items-center justify-between gap-3 border-b border-border pb-3">
    <div class="flex min-w-0 items-center gap-2">
      <Button variant="ghost" size="sm" class="-ml-2 shrink-0" @click="emit('back')">
        ← Back
      </Button>
      <h2 class="truncate text-lg font-semibold leading-tight">{{ title }}</h2>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
      <Button size="sm" @click="emit('done')">Done</Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Button } from '@/components/ui/button'

defineProps<{ title: string }>()
const emit = defineEmits<{ back: []; done: [] }>()
</script>
