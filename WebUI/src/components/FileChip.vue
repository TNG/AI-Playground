<template>
  <button
    type="button"
    class="file-link"
    :title="languages.ANSWER_FILE_PREVIEW_TOOLTIP"
    @click="emit('toggle', file)"
  >
    <span class="svg-icon i-document file-link-icon" aria-hidden="true"></span>
    <span class="break-all" :class="deleted ? 'line-through opacity-60' : ''">{{ file }}</span>
  </button>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'

/**
 * A created file as a clickable chip of the turn's Created-files row. A file
 * known to be deleted from disk shows its name struck out. The native `title`
 * mirrors the row's own conventions rather than the shadcn tips.
 */
defineProps<{ file: string; deleted?: boolean }>()

const emit = defineEmits<{ toggle: [file: string] }>()

const languages = useI18N().state
</script>
