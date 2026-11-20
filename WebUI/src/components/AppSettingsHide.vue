<template>
  <div class="flex flex-col gap-2">
    <AppSettingsRow
      :label="languages.SETTINGS_ENABLE_HIDING"
      :description="languages.SETTINGS_ENABLE_HIDING_INFO"
    >
      <template #default="{ id, describedBy }">
        <Switch
          :id="id"
          :aria-describedby="describedBy"
          :model-value="messageHiding.enabled"
          @update:model-value="(v) => (messageHiding.enabled = v === true)"
        />
      </template>
    </AppSettingsRow>
    <AppSettingsRow :label="languages.SETTINGS_HIDDEN_MESSAGES" :description="hiddenSummary">
      <template #default="{ describedBy }">
        <Button
          variant="outline"
          size="sm"
          :aria-describedby="describedBy"
          :disabled="sessions.sessionsWithHiddenMessages === 0"
          @click="sessions.unhideAllMessages()"
        >
          {{ languages.SETTINGS_UNHIDE_ALL }}
        </Button>
      </template>
    </AppSettingsRow>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useMessageHiding } from '@/assets/js/store/messageHiding'
import { useSessions } from '@/assets/js/store/sessions'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { fillTemplate } from '@/lib/fillTemplate'

const messageHiding = useMessageHiding()
const sessions = useSessions()
const languages = useI18N().state

// The per-Session hint points at the row menu, which only offers Unhide while hiding is on.
const hiddenSummary = computed(() => {
  const count = sessions.sessionsWithHiddenMessages
  if (count === 0) return languages.SETTINGS_HIDDEN_MESSAGES_NONE
  const summary = fillTemplate(languages.SETTINGS_HIDDEN_MESSAGES_COUNT, { count: String(count) })
  return messageHiding.enabled
    ? `${summary} ${languages.SETTINGS_HIDDEN_MESSAGES_PER_SESSION}`
    : summary
})
</script>
