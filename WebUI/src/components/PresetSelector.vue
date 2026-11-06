<template>
  <div v-if="selectedPreset" class="flex flex-col gap-6">
    <!-- Informational card: thumbnail, name, description and tags. -->
    <section
      role="group"
      :aria-label="`${displayName} preset information`"
      :data-aipg-preset-name="selectedPreset.name"
      class="flex flex-col gap-3 rounded-lg border border-border bg-muted/40 p-3"
    >
      <div class="flex flex-row items-start gap-3">
        <div
          :aria-label="displayName"
          class="relative shrink-0 w-28 h-28 rounded-lg overflow-hidden border border-border shadow-md"
        >
          <img
            v-if="selectedPreset.image"
            class="absolute inset-0 w-full h-full object-cover"
            :src="selectedPreset.image"
            :alt="displayName"
          />
          <div class="absolute bottom-0 w-full bg-background/60 text-center py-1">
            <span class="text-foreground text-sm font-semibold">
              {{ displayName }}
            </span>
          </div>
        </div>
        <div class="flex flex-col gap-1 min-w-0">
          <p v-if="infoDescription" class="text-sm text-muted-foreground whitespace-pre-line">
            {{ infoDescription }}
          </p>
        </div>
      </div>

      <div
        v-if="
          presetsStore.activePresetWithVariant?.tags &&
          presetsStore.activePresetWithVariant.tags.length > 0
        "
        class="flex flex-wrap gap-2"
      >
        <span
          v-for="tag in presetsStore.activePresetWithVariant.tags"
          :key="tag"
          class="px-2 py-0.5 text-xs bg-primary text-primary-foreground rounded-full"
        >
          {{ tag }}
        </span>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, watch, onMounted } from 'vue'
import { usePresets } from '@/assets/js/store/presets'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { extendedDescriptionText } from '@/assets/js/help/presetHelp'
interface Props {
  categories?: string[]
  type?: string
  modelValue?: string
}

const props = withDefaults(defineProps<Props>(), {
  categories: () => [],
  type: undefined,
  modelValue: undefined,
})

const emits = defineEmits<{
  (e: 'update:modelValue', value: string): void
}>()

const presetsStore = usePresets()
const oemBranding = useOemBranding()

const filteredPresets = computed(() => {
  return presetsStore.getPresetsByCategories(props.categories || [], props.type)
})

const selectedPresetName = computed(() => {
  return props.modelValue || presetsStore.activePresetName
})

const selectedPreset = computed(() => {
  if (!selectedPresetName.value) return null
  return filteredPresets.value.find((p) => p.name === selectedPresetName.value) || null
})

// What the user reads. Differs from `selectedPreset.name` (the preset's identity)
// only where an OEM co-brands the feature, e.g. "Acer Game Agent".
const displayName = computed(() =>
  selectedPreset.value ? oemBranding.presetLabel(selectedPreset.value.name) : '',
)

const activeVariantName = computed(() => {
  if (!selectedPresetName.value) return null
  return presetsStore.activeVariantName[selectedPresetName.value] || null
})

const extendedDescription = computed(() =>
  extendedDescriptionText(selectedPreset.value, activeVariantName.value),
)

// The "info" description shown beside the preset icon: the extended how-to text
// (same content the info box used to show), falling back to the preset's base
// description. Deliberately NOT the variant-merged description, which is the
// quality-mode (fast/quality) blurb.
const infoDescription = computed(
  () => extendedDescription.value || selectedPreset.value?.description,
)

// Auto-select lastUsed preset on mount if no preset is selected
onMounted(() => {
  if (!selectedPresetName.value) {
    const categories =
      props.categories && props.categories.length > 0
        ? props.categories
        : props.type === 'chat'
          ? ['chat']
          : []

    if (categories.length > 0) {
      const lastUsed = presetsStore.getLastUsedPreset(categories)
      if (lastUsed) {
        emits('update:modelValue', lastUsed)
      } else if (filteredPresets.value.length > 0) {
        // Fallback to first preset if no lastUsed
        emits('update:modelValue', filteredPresets.value[0].name)
      }
    } else if (filteredPresets.value.length > 0) {
      // If no categories/type specified, just select first preset
      emits('update:modelValue', filteredPresets.value[0].name)
    }
  }
})

// Watch for changes in filtered presets and auto-select if current selection is no longer valid
// Use a deep comparison to avoid triggering when the array reference changes but content is the same
watch(
  filteredPresets,
  (newPresets, oldPresets) => {
    // Only proceed if the selection actually changed (preset names differ)
    const newPresetNames = newPresets
      .map((p) => p.name)
      .sort()
      .join(',')
    const oldPresetNames =
      oldPresets
        ?.map((p) => p.name)
        .sort()
        .join(',') || ''

    // Skip if preset names haven't actually changed (just array reference changed)
    if (newPresetNames === oldPresetNames && selectedPresetName.value) {
      return
    }

    if (selectedPresetName.value) {
      const stillExists = newPresets.some((p) => p.name === selectedPresetName.value)
      if (!stillExists) {
        // Current selection is no longer in the filtered list
        const categories =
          props.categories && props.categories.length > 0
            ? props.categories
            : props.type === 'chat'
              ? ['chat']
              : []
        const lastUsed = categories.length > 0 ? presetsStore.getLastUsedPreset(categories) : null
        if (lastUsed && newPresets.some((p) => p.name === lastUsed)) {
          emits('update:modelValue', lastUsed)
        } else if (newPresets.length > 0) {
          emits('update:modelValue', newPresets[0].name)
        }
      }
    }
  },
  { deep: false }, // Don't deep watch, we'll do our own comparison
)
</script>
