<template>
  <div class="w-full rounded-md border border-border p-3">
    <div class="mb-2 flex items-center justify-between gap-2">
      <span
        class="min-w-0 flex-1 truncate text-muted-foreground"
        :class="textInference.nameSizeClass"
        >{{ file }}</span
      >
      <button
        v-if="!gone"
        type="button"
        class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        :title="languages.ANSWER_FILE_OPEN_TOOLTIP"
        :aria-label="languages.ANSWER_FILE_OPEN_TOOLTIP"
        @click="openAnswerFile(file)"
      >
        <ArrowTopRightOnSquareIcon class="size-4" aria-hidden="true" />
      </button>
      <button
        v-if="!gone"
        type="button"
        class="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
        :title="languages.ARTIFACT_DELETE"
        :aria-label="languages.ARTIFACT_DELETE"
        @click="confirming = true"
      >
        <TrashIcon class="size-4" aria-hidden="true" />
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
      <div
        class="overflow-y-auto transition-[max-height] duration-300 ease-out"
        :class="expanded ? 'max-h-105' : 'max-h-80'"
      >
        <MarkdownRenderer :content="markdown" />
      </div>
      <p
        v-if="truncated && expanded"
        class="mt-2 text-muted-foreground"
        :class="textInference.nameSizeClass"
      >
        {{ languages.ANSWER_FILE_PREVIEW_TRUNCATED }}
      </p>
      <Button
        v-if="truncated !== expanded"
        variant="outline"
        size="xs"
        class="mt-2"
        @click="toggleExpanded"
      >
        {{
          expanded
            ? languages.ANSWER_FILE_PREVIEW_SHOW_LESS
            : languages.ANSWER_FILE_PREVIEW_SHOW_MORE
        }}
        <ChevronUpIcon v-if="expanded" aria-hidden="true" />
        <ChevronDownIcon v-else aria-hidden="true" />
      </Button>
    </template>
    <DeleteArtifactDialog
      :open="confirming"
      @update:open="(value) => (confirming = value)"
      @confirm="deleteFile"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { createAppError } from '@/assets/js/errors/appError'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { useTextInference } from '@/assets/js/store/textInference'
import DeleteArtifactDialog from '@/components/DeleteArtifactDialog.vue'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import { Button } from '@/components/ui/button'
import { previewMarkdownOf } from '@/lib/filePreview'
import { useAnswerFileOpener } from '@/lib/useAnswerFileOpener'
import {
  ArrowTopRightOnSquareIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'

/**
 * A written file's text inline in the turn: markdown renders as itself, other
 * files as one highlighted block. The pane scrolls inside its capped height,
 * so expanding only adds scroll range — the box, and the button under it, stay
 * put. The corner icons open the file with the OS default app — the only way
 * past the expansion ceiling — and trash it, with the Artifacts tab's confirm.
 */
const props = defineProps<{ file: string; sessionId?: string }>()

// The read is also the existence check: a file reported gone tells the chip to
// strike itself out, a successful read tells it to un-strike.
const emit = defineEmits<{ missing: []; present: []; deleted: [] }>()

const errors = useErrors()
const languages = useI18N().state
const textInference = useTextInference()
const openAnswerFile = useAnswerFileOpener(() => props.sessionId)

const state = ref<'loading' | 'error' | 'ready'>('loading')
const error = ref('')
const content = ref('')
const truncated = ref(false)
const expanded = ref(false)
// Proven gone by the preview's own read: a deleted file offers no delete.
const gone = ref(false)
const markdown = computed(() => previewMarkdownOf(props.file, content.value))

async function fetchContent(): Promise<void> {
  if (!props.sessionId) {
    state.value = 'error'
    error.value = 'This turn has no workspace folder.'
    return
  }
  const result = await window.electronAPI.agentMode.readSessionFile(
    props.sessionId,
    props.file,
    expanded.value || undefined,
  )
  if (!result.success) {
    state.value = 'error'
    error.value = result.error ?? ''
    if ('missing' in result && result.missing) {
      gone.value = true
      emit('missing')
    }
    return
  }
  content.value = result.data.content
  truncated.value = result.data.truncated
  state.value = 'ready'
  gone.value = false
  emit('present')
}

onMounted(fetchContent)

async function toggleExpanded(): Promise<void> {
  expanded.value = !expanded.value
  await fetchContent()
}

const confirming = ref(false)

async function deleteFile(): Promise<void> {
  confirming.value = false
  const sessionId = props.sessionId
  if (!sessionId) return
  const result = await window.electronAPI.agentMode.sessionFileAction(
    sessionId,
    props.file,
    'delete',
  )
  if (!result.success) {
    errors.report(
      createAppError({
        category: 'file',
        code: 'answer/file-delete-failed',
        userMessage: result.error ?? '',
        technicalMessage: `sessionFileAction failed for ${props.file}`,
        surface: 'toast',
        context: { sessionId, filePath: props.file },
      }),
    )
    return
  }
  emit('deleted')
  await fetchContent()
}
</script>
