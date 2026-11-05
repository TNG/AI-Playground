<template>
  <template v-if="promptStore.getCurrentMode() === 'chat'">
    <Button
      id="camera-button"
      class="bg-muted hover:bg-muted/80 text-foreground rounded-lg px-3 py-1.5"
      variant="secondary"
      :disabled="downloading"
      @click="emit('camera')"
      title="Capture image from camera"
    >
      <AcerCameraIcon class="w-5 h-5" />
    </Button>
    <Button
      id="microphone-button"
      class="bg-muted hover:bg-muted/80 text-foreground rounded-lg px-3 py-1.5"
      variant="secondary"
      @click="emit('record')"
      :disabled="
        (!sttAvailable && !audioRecorder.isRecording) ||
        audioRecorder.isTranscribing ||
        preparingStt ||
        downloading
      "
      :title="preparingStt ? 'Starting speech service…' : sttAvailable ? '' : sttUnavailableHint"
    >
      <i
        v-if="!audioRecorder.isTranscribing && !preparingStt"
        class="svg-icon w-5 h-5"
        :class="audioRecorder.isRecording ? 'i-record-active' : 'i-record'"
      ></i>
      <span
        v-else
        class="svg-icon i-loading w-5 h-5 animate-spin inline-block"
        :aria-label="preparingStt ? 'Starting speech service' : 'Transcribing'"
      ></span>
      <div v-if="audioRecorder.isRecording" class="absolute -top-11 flex gap-1 items-end h-10">
        <div
          v-for="i in 5"
          :key="i"
          class="w-1.5 bg-primary rounded-full transition-all duration-100"
          :style="{
            height: `${Math.max(6, (audioRecorder.audioLevel / 100) * 40 * (i / 5))}px`,
            opacity: audioRecorder.audioLevel > (i - 1) * 20 ? 1 : 0.35,
          }"
        ></div>
      </div>
    </Button>
  </template>
</template>

<script setup lang="ts">
import { useAudioRecorder } from '@/assets/js/store/audioRecorder'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { preparingStt } from '@/assets/js/speech/speechIO'
import AcerCameraIcon from '@/components/AcerCameraIcon.vue'
import Button from '@/components/ui/button/Button.vue'

defineProps<{
  downloading: boolean
  sttAvailable: boolean
  sttUnavailableHint: string
}>()

const emit = defineEmits<{
  (e: 'camera'): void
  (e: 'record'): void
}>()

const audioRecorder = useAudioRecorder()
const promptStore = usePromptStore()
</script>
