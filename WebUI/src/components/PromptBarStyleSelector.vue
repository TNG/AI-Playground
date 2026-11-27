<template>
  <drop-down-new
    :items="styleItems"
    :value="promptBarStyle.active"
    @change="(value) => (promptBarStyle.selected = value as PromptBarStyle)"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  PROMPT_BAR_STYLES,
  usePromptBarStyle,
  type PromptBarStyle,
} from '@/assets/js/store/promptBarStyle'
import { useI18N } from '@/assets/js/store/i18n'
import DropDownNew from '@/components/DropDownNew.vue'

const promptBarStyle = usePromptBarStyle()
const i18nState = useI18N().state

const styleItems = computed(() =>
  PROMPT_BAR_STYLES.map((style) => ({
    label:
      style === 'modern'
        ? i18nState.SETTINGS_PROMPT_BAR_STYLE_MODERN
        : i18nState.SETTINGS_PROMPT_BAR_STYLE_CLASSIC,
    value: style,
    active: true,
  })),
)
</script>
