<template>
  <div class="flex flex-col gap-2">
    <SettingsHeading>{{ languages.SETTINGS_PROMPT_BAR_STYLE }}</SettingsHeading>
    <PromptBarStyleSelector />
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import PromptBarStyleSelector from '@/components/PromptBarStyleSelector.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'

const languages = useI18N().state
</script>
