<template>
  <div class="flex flex-col gap-2">
    <AppSettingsRow :label="languages.COM_THEME">
      <ThemePicker />
      <Button variant="link" size="sm" @click="ui.openThemePanel()">
        {{ languages.THEME_CUSTOMIZE }}
      </Button>
    </AppSettingsRow>
    <ThemeFallbackNotice />
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { useUIStore } from '@/assets/js/store/ui'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import ThemeFallbackNotice from '@/components/ThemeFallbackNotice.vue'
import ThemePicker from '@/components/ThemePicker.vue'
import { Button } from '@/components/ui/button'

const languages = useI18N().state
const ui = useUIStore()
</script>
