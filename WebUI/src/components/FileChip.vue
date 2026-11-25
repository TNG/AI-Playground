<template>
  <button
    type="button"
    class="file-link"
    :title="languages.ANSWER_FILE_OPEN_TOOLTIP"
    @click="emit('open', file)"
  >
    <span class="svg-icon i-document file-link-icon" aria-hidden="true"></span>
    <span class="break-all">{{ file }}</span>
  </button>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'

/**
 * A created file as a clickable chip: same markup and styles the markdown
 * parser emits for a prose mention, so both surfaces look and behave alike.
 * The native `title` mirrors the parser's chips rather than the shadcn tips.
 */
defineProps<{ file: string }>()

const emit = defineEmits<{ open: [file: string] }>()

const languages = useI18N().state
</script>
