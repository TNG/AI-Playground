<template>
  <div class="flex flex-col gap-2">
    <SettingsHeading>{{ languages.SETTINGS_SPEECH }}</SettingsHeading>
    <!-- Text to Speech fallback: enabling it adds an "External endpoint" engine
         option to the Text to Speech preset (works in every product mode). -->
    <AppSettingsRow
      v-slot="{ id, describedBy }"
      :label="languages.SETTINGS_SPEECH_TTS_ENDPOINT"
      :description="languages.SETTINGS_SPEECH_TTS_ENDPOINT_INFO"
    >
      <Switch :id="id" v-model="textToSpeech.fallback.enabled" :aria-describedby="describedBy" />
    </AppSettingsRow>
    <!-- Speech to Text fallback: enabling it adds an "External endpoint" engine to
         the Speech to Text preset AND makes that preset available in NVIDIA mode
         (Whisper/OpenVINO is otherwise unavailable there). -->
    <AppSettingsRow
      v-slot="{ id, describedBy }"
      :label="languages.SETTINGS_SPEECH_STT_ENDPOINT"
      :description="languages.SETTINGS_SPEECH_STT_ENDPOINT_INFO"
    >
      <Switch :id="id" v-model="speechToText.fallback.enabled" :aria-describedby="describedBy" />
    </AppSettingsRow>
  </div>
</template>

<script setup lang="ts">
import { useSpeechToText } from '@/assets/js/store/speechToText'
import { useTextToSpeech } from '@/assets/js/store/textToSpeech'
import { useI18N } from '@/assets/js/store/i18n'
import AppSettingsRow from '@/components/AppSettingsRow.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Switch } from '@/components/ui/switch'

const speechToText = useSpeechToText()
const textToSpeech = useTextToSpeech()
const languages = useI18N().state
</script>
