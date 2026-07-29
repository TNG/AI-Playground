<template>
  <div class="flex flex-col gap-4">
    <!-- Install guidance: the Qwen3-TTS backend is required for any synthesis. -->
    <p
      v-if="!qwen3BackendSetUp"
      class="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-300"
    >
      Install the Text To Speech backend from Settings → Installation Management to enable speech
      synthesis.
    </p>

    <!-- Model row: a single fixed engine, shown where the LLM model picker normally is. -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
      <drop-down-new
        title="Model"
        :value="'qwen-tts'"
        :items="[{ label: 'Qwen TTS', value: 'qwen-tts', active: qwen3BackendSetUp }]"
        :disabled="true"
        @change="() => {}"
      ></drop-down-new>
    </div>

    <!-- Synthesis mode: named speaker vs. free-form voice description. -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Mode</Label>
      <drop-down-new
        title="Synthesis mode"
        :value="qwen3Tts.defaultMode"
        :items="modeItems"
        @change="(v) => (qwen3Tts.defaultMode = v as Qwen3TtsSynthesisMode)"
      ></drop-down-new>
    </div>

    <!-- Voice (speaker): only meaningful in custom_voice mode. -->
    <div
      v-if="qwen3Tts.defaultMode === 'custom_voice'"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">Voice</Label>
      <drop-down-new
        title="Voice"
        :value="qwen3Tts.defaultSpeaker"
        :items="speakerItems"
        @change="(v) => (qwen3Tts.defaultSpeaker = v as Qwen3TtsSpeakerId)"
      ></drop-down-new>
    </div>

    <!-- Voice description (instruct): drives voice_design synthesis. -->
    <div v-else class="grid grid-cols-[120px_1fr] items-start gap-4">
      <Label class="whitespace-nowrap pt-2">Voice description</Label>
      <Textarea
        v-model="qwen3Tts.defaultInstruct"
        placeholder="e.g. A calm middle-aged British man, warm and reassuring."
        class="min-h-[72px] text-sm"
      />
    </div>

    <!-- Language applies to both modes. -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Language</Label>
      <drop-down-new
        title="Language"
        :value="qwen3Tts.defaultLanguage"
        :items="languageItems"
        @change="(v) => (qwen3Tts.defaultLanguage = v as Qwen3TtsLanguage)"
      ></drop-down-new>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import DropDownNew from '@/components/DropDownNew.vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useQwen3TextToSpeech } from '@/assets/js/store/qwen3TextToSpeech'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { QWEN3_TTS_LANGUAGES, QWEN3_TTS_SPEAKERS } from '@/assets/js/qwen3TtsConstants'
import type {
  Qwen3TtsLanguage,
  Qwen3TtsSpeakerId,
  Qwen3TtsSynthesisMode,
} from '@/assets/js/qwen3TtsConstants'

const languages = useI18N().state
const qwen3Tts = useQwen3TextToSpeech()
const backendServices = useBackendServices()

const qwen3BackendSetUp = computed(
  () => backendServices.info.find((s) => s.serviceName === 'qwen3-tts-backend')?.isSetUp === true,
)

const modeItems = [
  { label: 'Custom voice', value: 'custom_voice', active: true },
  { label: 'Voice design', value: 'voice_design', active: true },
]

const speakerItems = QWEN3_TTS_SPEAKERS.map((sp) => ({
  label: `${sp.id} — ${sp.nativeLanguage}`,
  value: sp.id,
  active: true,
}))

const languageItems = QWEN3_TTS_LANGUAGES.map((lang) => ({
  label: lang,
  value: lang,
  active: true,
}))
</script>
