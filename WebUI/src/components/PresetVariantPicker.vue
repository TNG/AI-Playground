<template>
  <div
    v-if="variantSelectorOptions.length > 1"
    class="grid grid-cols-[120px_1fr] items-center gap-4"
  >
    <Label class="whitespace-nowrap">Variant</Label>
    <VariantSelector
      v-model="selectedVariantValue"
      :options="variantSelectorOptions"
      :columns="Math.min(variantSelectorOptions.length, 3)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import { usePresets } from '@/assets/js/store/presets'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { Label } from '@/components/ui/label'
import VariantSelector, { type VariantOption } from '@/components/VariantSelector.vue'

const emits = defineEmits<{
  (e: 'update:variant', presetName: string, variantName: string | null): void
}>()

const presetsStore = usePresets()
const backendServices = useBackendServices()

const selectedPreset = computed(() => presetsStore.activePreset)

const activeVariantName = computed(() => {
  const name = selectedPreset.value?.name
  if (!name) return null
  return presetsStore.activeVariantName[name] || null
})

function isVariantAvailable(variant: { requiresService?: string }): boolean {
  if (!variant.requiresService) return true
  const info = backendServices.info.find((s) => s.serviceName === variant.requiresService)
  if (!info) return false
  return info.status !== 'notInstalled'
}

// Variants are grouped by `backend` (defaulting to 'comfyui'); the Backend dropdown in
// SettingsWorkflowInferencing.vue picks the group shown here.
const availableVariants = computed(() => {
  if (!selectedPreset.value?.variants) return []
  const activeBackend = presetsStore.getActiveBackend(selectedPreset.value.name) ?? 'comfyui'
  return selectedPreset.value.variants
    .filter((v) => (v.backend ?? 'comfyui') === activeBackend)
    .filter(isVariantAvailable)
})

const variantSelectorOptions = computed<VariantOption[]>(() => {
  const presetName = selectedPreset.value?.name ?? ''
  return availableVariants.value.map((variant, index) => ({
    id: `variant-${index}`,
    name: variant.displayName ?? variant.name,
    value: variant.name,
    presetName,
  }))
})

const selectedVariantValue = computed({
  get: () => {
    const variant = activeVariantName.value
    const available = availableVariants.value
    if (variant && !available.some((v) => v.name === variant)) {
      return available[0]?.name ?? ''
    }
    if (!variant && available.length > 0) {
      return available[0].name
    }
    return variant || ''
  },
  set: (value: string) => {
    if (!selectedPreset.value) return
    emits('update:variant', selectedPreset.value.name, value)
  },
})

// When the previously-active variant becomes unavailable (service uninstalled, or
// persisted state from another machine), reconcile it to the first available variant.
watch(
  [() => selectedPreset.value?.name, availableVariants],
  ([presetName, available]) => {
    if (!presetName) return
    const current = presetsStore.activeVariantName[presetName]
    if (!current) return
    if (available.some((v) => v.name === current)) return
    if (available.length === 0) return
    emits('update:variant', presetName, available[0].name)
  },
  { immediate: true },
)
</script>
