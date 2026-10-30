<script setup lang="ts">
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

defineProps<{
  label: string
  tooltip?: string
  disabled?: boolean
  active?: boolean
}>()

defineEmits<{ (e: 'click'): void }>()
</script>

<template>
  <Tooltip>
    <TooltipTrigger as-child>
      <Button
        variant="ghost"
        size="icon"
        class="h-7 w-7"
        :class="active ? 'text-primary' : 'text-muted-foreground hover:text-foreground'"
        :aria-label="label"
        :disabled="disabled"
        @click.stop="$emit('click')"
      >
        <slot />
      </Button>
    </TooltipTrigger>
    <TooltipContent class="max-w-xs">{{ tooltip ?? label }}</TooltipContent>
  </Tooltip>
</template>
