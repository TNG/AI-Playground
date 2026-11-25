<template>
  <div class="w-full rounded-md border border-border p-3">
    <div class="mb-2 flex items-center justify-between gap-2">
      <span
        class="min-w-0 flex-1 truncate text-muted-foreground"
        :class="textInference.nameSizeClass"
        >{{ file }}</span
      >
      <button
        type="button"
        class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        :title="languages.ANSWER_FILE_OPEN_TOOLTIP"
        :aria-label="languages.ANSWER_FILE_OPEN_TOOLTIP"
        @click="openAnswerFile(file)"
      >
        <ArrowTopRightOnSquareIcon class="size-4" aria-hidden="true" />
      </button>
    </div>
    <div v-if="state === 'loading'" class="h-4 w-3/4 animate-pulse rounded bg-muted" />
    <p
      v-else-if="state === 'error'"
      class="text-muted-foreground"
      :class="textInference.nameSizeClass"
    >
      {{ error }}
    </p>
    <template v-else>
      <MarkdownRenderer :content="markdown" />
      <p v-if="truncated" class="mt-2 text-muted-foreground" :class="textInference.nameSizeClass">
        {{ languages.ANSWER_FILE_PREVIEW_TRUNCATED }}
      </p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useTextInference } from '@/assets/js/store/textInference'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import { previewMarkdownOf } from '@/lib/filePreview'
import { useAnswerFileOpener } from '@/lib/useAnswerFileOpener'
import { ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline'

/**
 * A written file's text inline in the turn: markdown renders as itself, other
 * files as one highlighted block. The corner icon opens it with the OS default
 * app, which is also the only way past the preview's size cap.
 */
const props = defineProps<{ file: string; sessionId?: string }>()

const languages = useI18N().state
const textInference = useTextInference()
const openAnswerFile = useAnswerFileOpener(() => props.sessionId)

const state = ref<'loading' | 'error' | 'ready'>('loading')
const error = ref('')
const content = ref('')
const truncated = ref(false)
const markdown = computed(() => previewMarkdownOf(props.file, content.value))

onMounted(async () => {
  if (!props.sessionId) {
    state.value = 'error'
    error.value = 'This turn has no workspace folder.'
    return
  }
  const result = await window.electronAPI.agentMode.readSessionFile(props.sessionId, props.file)
  if (!result.success) {
    state.value = 'error'
    error.value = result.error ?? ''
    return
  }
  content.value = result.data.content
  truncated.value = result.data.truncated
  state.value = 'ready'
})
</script>
