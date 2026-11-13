<script setup lang="ts">
import { computed, useId, useSlots } from 'vue'
import { Label } from '@/components/ui/label'

const props = defineProps<{
  label: string
  description?: string
  /** Dims the label; the control is disabled by its own prop. */
  disabled?: boolean
  /** Puts the control full-width under the label, for inputs and lists. */
  wide?: boolean
}>()

defineSlots<{
  /** Bind `id` and `aria-describedby` on a switch or input so the label names it. */
  default(props: { id: string; describedBy: string | undefined }): unknown
  description?(): unknown
}>()

const slots = useSlots()
const id = useId()
const descriptionId = `${id}-description`
const hasDescription = computed(() => !!props.description || !!slots.description)
const control = computed(() => ({
  id,
  describedBy: hasDescription.value ? descriptionId : undefined,
}))
</script>

<template>
  <div class="flex gap-x-6 gap-y-2 py-2" :class="wide ? 'flex-col' : 'items-center'">
    <div class="flex min-w-0 flex-1 flex-col gap-1">
      <Label :for="id" :class="{ 'opacity-50': disabled }">{{ label }}</Label>
      <div v-if="hasDescription" :id="descriptionId" class="text-xs text-muted-foreground">
        <slot name="description">{{ description }}</slot>
      </div>
    </div>
    <div
      class="flex shrink-0 items-center gap-2"
      :class="{ 'w-full flex-col items-stretch': wide }"
    >
      <slot v-bind="control" />
    </div>
  </div>
</template>
