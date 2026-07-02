<template>
  <drop-down-new
    title="Select Provider"
    @change="handleProviderChange"
    :value="hybridMode.selectedProviderId"
    :items="items"
  ></drop-down-new>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import DropDownNew from './DropDownNew.vue'
import { useHybridMode } from '@/assets/js/store/hybridMode'

const hybridMode = useHybridMode()

// Switching provider re-fetches that provider's model list (overwriting it on
// success), so the model picker reflects what the newly-selected provider serves.
function handleProviderChange(id: string) {
  hybridMode.selectProvider(id)
  hybridMode.refreshSelectedProviderModels()
}

const items = computed(() =>
  hybridMode.providers.map((p) => ({
    label: p.name,
    value: p.id,
    // A provider is "ready" once it has a base URL configured.
    active: !!p.baseUrl.trim(),
  })),
)
</script>
