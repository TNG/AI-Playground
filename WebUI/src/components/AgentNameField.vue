<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { Button } from '@/components/ui/button'

const props = defineProps<{
  idPrefix: string
  label: string
  submitLabel: string
  cancelLabel?: string
  placeholder?: string
  /** Why it cannot be submitted yet; shown under the field. */
  blocker?: string
  busy?: boolean
  autofocus?: boolean
}>()

const emit = defineEmits<{ (e: 'submit'): void; (e: 'cancel'): void }>()

const name = defineModel<string>({ required: true })
const input = ref<HTMLInputElement | null>(null)

onMounted(() => {
  if (props.autofocus) input.value?.select()
})

function submit(): void {
  if (props.blocker || props.busy) return
  emit('submit')
}
</script>

<template>
  <div class="flex flex-col gap-1">
    <div class="flex items-center gap-1.5">
      <input
        :id="`${idPrefix}-input`"
        ref="input"
        v-model="name"
        autocomplete="off"
        :aria-label="label"
        :aria-describedby="blocker ? `${idPrefix}-blocker` : undefined"
        :placeholder="placeholder"
        class="flex h-7 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm text-foreground shadow-sm placeholder:text-muted-foreground focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
        @keydown.enter.prevent="submit"
        @keydown.escape.prevent="emit('cancel')"
      />
      <Button size="sm" class="h-7 flex-none" :disabled="!!blocker || busy" @click="submit">
        {{ submitLabel }}
      </Button>
      <Button
        v-if="cancelLabel"
        variant="secondary"
        size="sm"
        class="h-7 flex-none"
        @click="emit('cancel')"
      >
        {{ cancelLabel }}
      </Button>
    </div>
    <p v-if="blocker" :id="`${idPrefix}-blocker`" class="text-xs text-muted-foreground">
      {{ blocker }}
    </p>
  </div>
</template>
