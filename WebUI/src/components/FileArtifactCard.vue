<template>
  <div
    role="group"
    :aria-label="file"
    class="flex h-full flex-col overflow-hidden rounded-lg border border-border bg-muted"
  >
    <div class="flex aspect-square min-h-0 items-center justify-center overflow-hidden bg-accent">
      <div v-if="state === 'loading'" class="h-1/2 w-3/4 animate-pulse rounded bg-muted"></div>
      <p v-else-if="state === 'error'" class="px-3 text-center text-xs text-muted-foreground">
        {{ error }}
      </p>
      <!-- The tile shows what fits of the file's peek — overflow is clipped, never scrolled. -->
      <div
        v-else
        class="h-full w-full overflow-hidden [&_.hljs]:m-0 [&_.hljs]:h-full [&_.hljs]:p-2 [&_.hljs]:text-xs [&_.hljs]:leading-tight"
        v-html="snippet"
      ></div>
    </div>
    <div class="flex flex-1 flex-col gap-1 px-3 py-2">
      <p class="truncate text-sm">{{ file }}</p>
      <p class="truncate text-xs text-muted-foreground">
        <template v-if="allSessions">{{ title }} · </template>
        {{ relativeTime(createdAt) }}
      </p>
      <div class="mt-1 flex items-center justify-between gap-2">
        <Button
          v-if="sessionRef && sessionRef !== sessions.openSessionId"
          variant="ghost"
          size="sm"
          class="px-2"
          @click="openSessionRef()"
        >
          {{ languages.GALLERY_OPEN_SESSION }}
        </Button>
        <span v-else></span>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8"
              :aria-label="languages.ANSWER_FILE_OPEN_TOOLTIP"
              @click="openAnswerFile(file)"
            >
              <ArrowTopRightOnSquareIcon class="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ languages.ANSWER_FILE_OPEN_TOOLTIP }}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowTopRightOnSquareIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { relativeTime } from '@/assets/js/store/recordRows'
import { useSessionLifecycle } from '@/assets/js/store/sessionLifecycle'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionTabs } from '@/assets/js/store/sessionTabs'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { snippetHtmlOf } from '@/lib/filePreview'
import { useAnswerFileOpener } from '@/lib/useAnswerFileOpener'

/** A written file as an Artifacts-grid card: the square tile shows what fits of the file's peek. */
const props = defineProps<{
  file: string
  /** The Harness Session whose workspace holds the file; the preview opens against it. */
  harnessSessionId: string
  createdAt: number
  sessionTitle: string
  /** The Session whose timeline wrote the file; another Session's card offers to open it. */
  sessionRef: string
}>()

const languages = useI18N().state
const sessions = useSessions()
const sessionTabs = useSessionTabs()
const lifecycle = useSessionLifecycle()
const openAnswerFile = useAnswerFileOpener(() => props.harnessSessionId)

const allSessions = computed(() => sessionTabs.artifactsScope === 'all-sessions')
const title = computed(() => props.sessionTitle || languages.SESSIONS_UNTITLED)

async function openSessionRef(): Promise<void> {
  await lifecycle.openSession(props.sessionRef, 'open-from-artifacts')
}

const state = ref<'loading' | 'error' | 'ready'>('loading')
const error = ref('')
const snippet = ref('')

onMounted(async () => {
  const result = await window.electronAPI.agentMode.readSessionFile(
    props.harnessSessionId,
    props.file,
    undefined,
  )
  if (!result.success) {
    state.value = 'error'
    error.value = result.error ?? ''
    return
  }
  snippet.value = snippetHtmlOf(props.file, result.data.content)
  state.value = 'ready'
})
</script>
