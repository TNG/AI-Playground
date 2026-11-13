<template>
  <DemoModeBlocker>
    <div class="flex flex-col gap-2">
      <SettingsHeading>{{ languages.SETTINGS_BASIC_LANGUAGE }}</SettingsHeading>
      <LanguageSelector></LanguageSelector>
      <label class="flex items-start gap-3 pt-1">
        <Switch
          v-model="chatAware.enabled"
          :aria-label="languages.SETTINGS_CHAT_AWARE"
          aria-describedby="app-settings-chat-aware-info"
        />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="text-sm">{{ languages.SETTINGS_CHAT_AWARE }}</span>
          <span id="app-settings-chat-aware-info" class="text-xs text-muted-foreground">
            {{ languages.SETTINGS_CHAT_AWARE_INFO }}
          </span>
        </span>
      </label>
    </div>
  </DemoModeBlocker>
</template>

<script setup lang="ts">
import { useChatAware } from '@/assets/js/store/chatAware'
import { useI18N } from '@/assets/js/store/i18n'
import DemoModeBlocker from '@/components/DemoModeBlocker.vue'
import LanguageSelector from '@/components/LanguageSelector.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Switch } from '@/components/ui/switch'

const languages = useI18N().state
const chatAware = useChatAware()
</script>
