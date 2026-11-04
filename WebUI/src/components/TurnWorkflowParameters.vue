<template>
  <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
    <template v-for="row in rows" :key="row.key">
      <dt class="text-muted-foreground">{{ row.label }}</dt>
      <dd class="min-w-0 wrap-break-word">
        <img
          v-if="row.image"
          :src="row.value"
          :alt="row.label"
          class="max-h-16 w-auto rounded-sm border border-border"
        />
        <template v-else>{{ row.value }}</template>
      </dd>
    </template>
  </dl>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { generationSettingLabelKeys } from '@/lib/generationSettingLabels'
import { getTranslationLabel } from '@/lib/utils'
import type { ComfyDynamicInputWithCurrent, GenerationSettings } from '@/types/mediaItem'

/** A ComfyUI Turn's variant and workflow parameters, as Turn Details lists them. */
const props = defineProps<{
  variant?: string
  settings: GenerationSettings
  inputs: ComfyDynamicInputWithCurrent[]
}>()

const languages = useI18N().state

type Row = { key: string; label: string; value: string; image?: boolean }

const rows = computed<Row[]>(() => [
  ...(props.variant
    ? [{ key: 'variant', label: languages.SETTINGS_IMAGE_VARIANT, value: props.variant }]
    : []),
  ...(Object.entries(props.settings) as [keyof GenerationSettings, unknown][]).map(
    ([key, value]) => ({
      key,
      label: languages[generationSettingLabelKeys[key]] ?? key,
      value: String(value),
    }),
  ),
  ...props.inputs.map((input) => ({
    key: `${input.nodeTitle}.${input.nodeInput}`,
    label: languages[getTranslationLabel('SETTINGS_IMAGE_COMFY_', input.label)] ?? input.label,
    value: String(input.current),
    image: input.type === 'image',
  })),
])
</script>
