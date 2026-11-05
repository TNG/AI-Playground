<template>
  <div
    class="self-center border border-dashed border-border rounded-md p-1 hover:cursor-pointer origin-bottom-left"
    :class="{ 'border-primary bg-primary/10': isOverDropZone }"
    id="plus-icon"
  >
    <Label htmlFor="file-attachment" @click="handlePlusIconClick">
      <PlusIcon class="size-4 cursor-pointer" />
    </Label>
    <input
      type="file"
      class="hidden"
      id="file-attachment"
      aria-label="Attach image or document"
      :accept="acceptedFileTypes"
      multiple
      @change="(e: Event) => emit('attach', e)"
    />
  </div>
</template>

<script setup lang="ts">
import { PlusIcon } from '@heroicons/vue/24/outline'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { Label } from '@/components/ui/label'
import * as toast from '@/assets/js/toast'

defineProps<{
  acceptedFileTypes: string
  isOverDropZone: boolean
}>()

const emit = defineEmits<{
  (e: 'attach', event: Event): void
}>()

const demoMode = useDemoMode()

function handlePlusIconClick(event: MouseEvent) {
  if (demoMode.triggerFirstTimeHelp('plus-icon')) {
    event.preventDefault()
    return
  }
  if (demoMode.enabled) {
    event.preventDefault()
    toast.show('Clicking this feature is disabled during demo.')
    return
  }
  // Let the Label's default behavior open the file dialog
}
</script>
