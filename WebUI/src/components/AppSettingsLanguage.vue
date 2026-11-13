<template>
  <DemoModeBlocker>
    <div class="flex flex-col gap-2">
      <SettingsHeading>{{ languages.SETTINGS_BASIC_LANGUAGE }}</SettingsHeading>
      <LanguageSelector></LanguageSelector>
    </div>
  </DemoModeBlocker>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import DemoModeBlocker from '@/components/DemoModeBlocker.vue'
import LanguageSelector from '@/components/LanguageSelector.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'

const languages = useI18N().state
</script>
