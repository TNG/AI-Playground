<template>
  <div class="self-center flex" id="plus-icon">
    <Button
      as-child
      variant="secondary"
      class="bg-muted hover:bg-muted/80 text-foreground rounded-lg px-3 py-1.5 cursor-pointer"
      :class="{ 'ring-2 ring-primary bg-primary/10': isOverDropZone }"
    >
      <Label htmlFor="file-attachment" @click="handlePlusIconClick">
        <PaperClipIcon class="w-5 h-5" />
      </Label>
    </Button>
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
import { PaperClipIcon } from '@heroicons/vue/24/outline'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { Button } from '@/components/ui/button'
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
