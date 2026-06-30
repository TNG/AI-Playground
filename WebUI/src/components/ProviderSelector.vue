<template>
  <drop-down-new
    title="Select Provider"
    @change="hybridMode.selectProvider"
    :value="hybridMode.selectedProviderId"
    :items="items"
  ></drop-down-new>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import DropDownNew from './DropDownNew.vue'
import { useHybridMode } from '@/assets/js/store/hybridMode'

const hybridMode = useHybridMode()

const items = computed(() =>
  hybridMode.providers.map((p) => ({
    label: p.name,
    value: p.id,
    // A provider is "ready" once it has a base URL configured.
    active: !!p.baseUrl.trim(),
  })),
)
</script>
