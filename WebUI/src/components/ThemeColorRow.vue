<template>
  <li class="flex items-center justify-between gap-3">
    <Label :for="id" class="text-xs" :class="{ 'font-mono': monoLabel }">{{ label }}</Label>
    <div class="flex items-center gap-2">
      <span class="font-mono text-xs text-muted-foreground">{{ value }}</span>
      <input
        :id="id"
        type="color"
        class="size-7 cursor-pointer rounded-sm border border-border bg-transparent p-0"
        :value="value"
        @input="(e) => emit('pick', (e.target as HTMLInputElement).value)"
      />
    </div>
  </li>
</template>

<script setup lang="ts">
import { Label } from '@/components/ui/label'

defineProps<{ id: string; label: string; value: string; monoLabel?: boolean }>()
const emit = defineEmits<{ pick: [hex: string] }>()
</script>
