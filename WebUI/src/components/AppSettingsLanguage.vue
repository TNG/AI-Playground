<template>
  <div class="flex flex-col gap-2">
    <SettingsHeading>{{ languages.SETTINGS_BASIC_LANGUAGE }}</SettingsHeading>
    <AppSettingsRow :label="languages.SETTINGS_BASIC_LANGUAGE">
      <LanguageSelector />
    </AppSettingsRow>
    <AppSettingsRow
      v-slot="{ id, describedBy }"
      :label="languages.SETTINGS_CHAT_AWARE"
      :description="languages.SETTINGS_CHAT_AWARE_INFO"
    >
      <Switch :id="id" v-model="chatAware.enabled" :aria-describedby="describedBy" />
    </AppSettingsRow>
  </div>
</template>

<script setup lang="ts">
import { useChatAware } from '@/assets/js/store/chatAware'
import { useI18N } from '@/assets/js/store/i18n'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import LanguageSelector from '@/components/LanguageSelector.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Switch } from '@/components/ui/switch'

const languages = useI18N().state
const chatAware = useChatAware()
</script>
