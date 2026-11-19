<template>
  <div class="flex flex-col gap-2">
    <AppSettingsRow :label="languages.SETTINGS_ENABLE_HIDING">
      <template #default="{ id, describedBy }">
        <Switch
          :id="id"
          :aria-describedby="describedBy"
          :model-value="messageHiding.enabled"
          @update:model-value="(v) => setEnabled(v === true)"
        />
      </template>
    </AppSettingsRow>

    <div class="flex flex-col gap-2 pt-1">
      <Button
        variant="outline"
        size="sm"
        class="justify-start"
        :disabled="!sessions.openSessionId || sessions.openHiddenIds.length === 0"
        @click="unhideSession"
      >
        {{ languages.SETTINGS_UNHIDE_SESSION }}
      </Button>
      <Button
        variant="outline"
        size="sm"
        class="justify-start"
        :disabled="!sessions.anyHiddenMessages"
        @click="unhideAll"
      >
        {{ languages.SETTINGS_UNHIDE_ALL }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { useMessageHiding } from '@/assets/js/store/messageHiding'
import { useSessions } from '@/assets/js/store/sessions'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'

/**
 * The Hide messages group: the switch that gates hiding itself, and the two
 * ways back. Turning the switch off leaves hidden messages hidden; it only
 * takes the Hide buttons out of the timeline.
 */
const messageHiding = useMessageHiding()
const sessions = useSessions()
const languages = useI18N().state

function setEnabled(enabled: boolean): void {
  messageHiding.enabled = enabled
}

async function unhideSession(): Promise<void> {
  const id = sessions.openSessionId
  if (!id) return
  await sessions.unhideSessionMessages(id)
}

async function unhideAll(): Promise<void> {
  await sessions.unhideAllMessages()
}
</script>
