<template>
  <div class="dialog-container z-20">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55 flex justify-center items-center"
    >
      <div
        role="alertdialog"
        aria-labelledby="missing-workspace-heading"
        aria-describedby="missing-workspace-text"
        class="py-10 px-16 w-[34rem] max-w-[90vw] flex flex-col justify-center bg-card rounded-3xl gap-4 text-foreground animate-scale-in"
      >
        <h2 id="missing-workspace-heading" class="flex items-center gap-2 text-lg font-semibold">
          <ExclamationTriangleIcon class="size-5 text-warning" aria-hidden="true" />
          {{ i18nState.SESSION_WORKSPACE_MISSING_TITLE }}
        </h2>
        <p id="missing-workspace-text" class="break-words">{{ text }}</p>
        <p v-if="refusalText" role="alert" class="text-sm text-warning">{{ refusalText }}</p>
        <div class="flex flex-wrap justify-center items-center gap-4 mt-2">
          <button @click="answer(null)" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_CANCEL }}
          </button>
          <button
            v-if="agent"
            @click="answer('edit-agent')"
            class="bg-muted text-foreground py-1 px-4 rounded"
          >
            {{ i18nState.AGENT_LIBRARY_EDIT_AGENT }}
          </button>
          <button
            v-else
            @click="answer('start-new')"
            class="bg-muted text-foreground py-1 px-4 rounded"
          >
            {{ replaceLabel }}
          </button>
          <button @click="answer('locate')" class="bg-primary text-foreground py-1 px-4 rounded">
            {{ i18nState.SESSION_WORKSPACE_LOCATE }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import { useDialogStore, type MissingWorkspaceChoice } from '@/assets/js/store/dialogs'
import { useI18N } from '@/assets/js/store/i18n'
import { fillTemplate } from '@/lib/fillTemplate'
import { mountedFolderRefusalText } from '@/lib/mountedFolderRefusalText'

const dialogStore = useDialogStore()
const i18nState = useI18N().state

const agent = computed(() => dialogStore.missingWorkspaceQuestion?.agent)

const text = computed(() => {
  const missing = dialogStore.missingWorkspaceQuestion?.missing
  if (!missing) return ''
  return fillTemplate(
    agent.value
      ? i18nState.SESSION_WORKSPACE_AGENT_MISSING_TEXT
      : i18nState.SESSION_WORKSPACE_MISSING_TEXT,
    { folder: missing.name, path: missing.hostPath, agent: agent.value?.name ?? '' },
  )
})

const replaceLabel = computed(() =>
  dialogStore.missingWorkspaceQuestion?.missing.fallback
    ? i18nState.SESSION_WORKSPACE_USE_OWN
    : i18nState.SESSION_WORKSPACE_START_NEW,
)

const refusalText = computed(() =>
  mountedFolderRefusalText(dialogStore.missingWorkspaceQuestion?.refusal, i18nState),
)

function answer(choice: MissingWorkspaceChoice) {
  dialogStore.missingWorkspaceQuestion?.answer(choice)
}
</script>
