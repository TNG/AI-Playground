<template>
  <button
    type="button"
    class="file-link"
    :title="languages.ANSWER_FILE_PREVIEW_TOOLTIP"
    @click="emit('toggle', file)"
  >
    <span class="svg-icon i-document file-link-icon" aria-hidden="true"></span>
    <span class="break-all">{{ file }}</span>
  </button>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'

/**
 * A created file as a clickable chip of the turn's Created-files row. The
 * native `title` mirrors the row's own conventions rather than the shadcn tips.
 */
defineProps<{ file: string }>()

const emit = defineEmits<{ toggle: [file: string] }>()

const languages = useI18N().state
</script>
