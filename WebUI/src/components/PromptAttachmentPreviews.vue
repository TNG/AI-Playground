<template>
  <div
    v-for="preview in imagePreview"
    :key="preview.id"
    class="relative max-h-12 max-w-12 mr-2 aspect-square group"
  >
    <img
      :src="preview.url"
      alt="Image Preview"
      class="w-full h-full object-contain border border-dashed border-border rounded-md"
    />
    <button
      @click="removeImage(preview.id)"
      class="absolute -top-1 -right-1 opacity-0 group-hover:opacity-100 transition-opacity bg-background rounded-full p-0.5 text-muted-foreground hover:text-destructive"
      title="Remove image"
    >
      <XMarkIcon class="size-4" />
    </button>
  </div>
  <div
    v-for="clip in audioPreview"
    :key="clip.id"
    class="self-center flex items-center gap-1 px-1 py-0.5 text-xs bg-primary/20 border border-primary/30 rounded-md group"
  >
    <MusicalNoteIcon class="size-4 flex-none" />
    <span class="truncate max-w-40" :title="clip.part.filename">{{ clip.part.filename }}</span>
    <button
      @click="removeImage(clip.id)"
      class="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
      title="Remove attachment"
    >
      <XMarkIcon class="size-4" />
    </button>
  </div>
  <div
    v-for="(file, index) in agentMode.attachments"
    :key="`${file.name}-${index}`"
    class="self-center flex items-center gap-1 px-1 py-0.5 text-xs bg-primary/20 border border-primary/30 rounded-md group"
  >
    <PaperClipIcon class="size-4 flex-none" />
    <span class="truncate max-w-40" :title="file.name">{{ file.name }}</span>
    <button
      @click="agentMode.removeAttachment(index)"
      class="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive"
      title="Remove attachment"
    >
      <XMarkIcon class="size-4" />
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { MusicalNoteIcon, PaperClipIcon, XMarkIcon } from '@heroicons/vue/24/outline'
import { useOpenAiCompatibleChat } from '@/assets/js/store/openAiCompatibleChat'
import { useAgentMode } from '@/assets/js/store/agentMode'

const openAiCompatibleChat = useOpenAiCompatibleChat()
const agentMode = useAgentMode()

const attachmentPreview = computed(() =>
  openAiCompatibleChat.fileInput.map((part, id) => ({ id, url: part.url, part })),
)

const imagePreview = computed(() =>
  attachmentPreview.value.filter((item) => !item.part.mediaType?.startsWith('audio/')),
)

const audioPreview = computed(() =>
  attachmentPreview.value.filter((item) => item.part.mediaType?.startsWith('audio/')),
)

function removeImage(index: number) {
  openAiCompatibleChat.fileInput = openAiCompatibleChat.fileInput.filter((_, i) => i !== index)
}
</script>
