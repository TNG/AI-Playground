<template>
  <div class="dialog-container z-20">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55 flex justify-center items-center"
    >
      <div
        role="alertdialog"
        aria-labelledby="close-dialog-heading"
        class="py-10 px-20 w-500px flex flex-col justify-center bg-card rounded-3xl gap-4 text-foreground animate-scale-in"
      >
        <template v-if="lines.length > 0">
          <p id="close-dialog-heading">{{ i18nState.CLOSE_QUESTION_INTRO }}</p>
          <ul class="list-disc pl-6 flex flex-col gap-1">
            <li v-for="(line, index) in lines" :key="index">{{ line }}</li>
          </ul>
        </template>
        <p v-else id="close-dialog-heading">{{ i18nState.CLOSE_QUESTION_DONE }}</p>
        <p>{{ i18nState.CLOSE_QUESTION_ASK }}</p>
        <div class="flex justify-center items-center gap-6 mt-2">
          <button @click="answer('quit')" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.CLOSE_QUIT }}
          </button>
          <button @click="answer('minimize')" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.CLOSE_MINIMIZE }}
          </button>
          <button @click="answer('keep')" class="bg-primary text-foreground py-1 px-4 rounded">
            {{ i18nState.CLOSE_KEEP_OPEN }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useDialogStore } from '@/assets/js/store/dialogs'
import { useI18N } from '@/assets/js/store/i18n'
import { closeQuestionLines } from '@/lib/closeQuestionLines'
import type { CloseChoice } from '@/types/lifecycleIpc'

const dialogStore = useDialogStore()
const i18nState = useI18N().state

const lines = computed(() =>
  dialogStore.closeQuestion ? closeQuestionLines(dialogStore.closeQuestion, i18nState) : [],
)

function answer(choice: CloseChoice) {
  const question = dialogStore.closeQuestion
  if (!question) return
  dialogStore.closeQuestion = null
  window.electronAPI.lifecycle.answerClose({ requestId: question.requestId, answer: choice })
}
</script>
