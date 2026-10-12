<template>
  <drop-down-new
    title="Select Provider"
    @change="handleProviderChange"
    :value="props.modelValue ?? cloudMode.selectedProviderId"
    :items="items"
  ></drop-down-new>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import DropDownNew from './DropDownNew.vue'
import { useCloudMode } from '@/assets/js/store/cloudMode'

// With `modelValue` the picker is controlled (an Agent Maker task's own
// provider) and leaves the shared selection alone.
const props = defineProps<{ modelValue?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const cloudMode = useCloudMode()

// Switching provider re-fetches that provider's model list (overwriting it on
// success), so the model picker reflects what the newly-selected provider serves.
function handleProviderChange(id: string) {
  if (props.modelValue !== undefined) {
    emit('update:modelValue', id)
    cloudMode.fetchModels(id).catch(() => undefined)
    return
  }
  cloudMode.selectProvider(id)
  cloudMode.refreshSelectedProviderModels()
}

const items = computed(() =>
  cloudMode.providers.map((p) => ({
    label: p.name,
    value: p.id,
    // A provider is "ready" once it has a base URL configured.
    active: !!p.baseUrl.trim(),
  })),
)
</script>
