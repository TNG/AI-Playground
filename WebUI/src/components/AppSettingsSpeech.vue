<template>
  <div class="flex flex-col gap-3">
    <SettingsHeading>{{ languages.SETTINGS_SPEECH }}</SettingsHeading>
    <div class="pl-2 pt-2 flex flex-col gap-4">
      <!-- Text to Speech fallback: enabling it adds an "External endpoint" engine
           option to the Text to Speech preset (works in every product mode). -->
      <div>
        <div class="flex justify-between pr-4 items-center gap-4">
          <div class="flex items-center gap-2">
            <Label for="tts-fallback-enabled">{{ languages.SETTINGS_SPEECH_TTS_ENDPOINT }}</Label>
            <TooltipProvider :delay-duration="200">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-[320px]">
                  An OpenAI-compatible <code>/v1/audio/speech</code> server (base URL like
                  <code>http://127.0.0.1:8080/v1</code>). When enabled, it appears as the "External
                  endpoint" engine in the Text to Speech preset.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Checkbox id="tts-fallback-enabled" v-model="textToSpeech.fallback.enabled" />
        </div>
      </div>

      <!-- Speech to Text fallback: enabling it adds an "External endpoint" engine to
           the Speech to Text preset AND makes that preset available in NVIDIA mode
           (Whisper/OpenVINO is otherwise unavailable there). -->
      <div class="border-t border-white/10 pt-4">
        <div class="flex justify-between pr-4 items-center gap-4">
          <div class="flex items-center gap-2">
            <Label for="stt-fallback-enabled">{{ languages.SETTINGS_SPEECH_STT_ENDPOINT }}</Label>
            <TooltipProvider :delay-duration="200">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="svg-icon i-info w-4 h-4 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="bottom" class="max-w-[320px]">
                  An OpenAI-compatible transcription server — e.g. a local whisper.cpp
                  <code>whisper-server</code> with
                  <code>--inference-path "/v1/audio/transcriptions"</code> (base URL like
                  <code>http://127.0.0.1:2022/v1</code>). Enabling it also makes the Speech to Text
                  preset available in NVIDIA mode.
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </div>
          <Checkbox id="stt-fallback-enabled" v-model="speechToText.fallback.enabled" />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useSpeechToText } from '@/assets/js/store/speechToText'
import { useTextToSpeech } from '@/assets/js/store/textToSpeech'
import { useI18N } from '@/assets/js/store/i18n'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const speechToText = useSpeechToText()
const textToSpeech = useTextToSpeech()
const languages = useI18N().state
</script>
