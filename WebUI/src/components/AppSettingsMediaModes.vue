<template>
  <div class="flex flex-col gap-2">
    <SettingsHeading>{{ languages.SETTINGS_MEDIA_MODES }}</SettingsHeading>
    <AppSettingsRow
      v-slot="{ id, describedBy }"
      :label="languages.SETTINGS_MEDIA_MODES"
      :description="languages.SETTINGS_MEDIA_MODES_INFO"
    >
      <Switch :id="id" v-model="mediaModes.enabled" :aria-describedby="describedBy" />
    </AppSettingsRow>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { useMediaModes } from '@/assets/js/store/mediaModes'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Switch } from '@/components/ui/switch'

const languages = useI18N().state
const mediaModes = useMediaModes()
</script>
