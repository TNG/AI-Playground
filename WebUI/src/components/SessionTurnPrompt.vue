<template>
  <SessionUserBubble>
    <template v-if="prompt.inputImageUrl">
      <p v-if="sessions.isFileDeleted(prompt.inputImageUrl)" class="text-sm text-muted-foreground">
        {{ languages.SESSION_FILE_DELETED }}
      </p>
      <img
        v-else
        :src="prompt.inputImageUrl"
        :alt="languages.SESSION_TURN_INPUT_IMAGE"
        class="max-h-40 max-w-60 self-start rounded-sm object-contain"
      />
    </template>
    <template v-for="clip in prompt.audio ?? []" :key="clip.url">
      <p v-if="sessions.isFileDeleted(clip.url)" class="text-sm text-muted-foreground">
        {{ languages.SESSION_FILE_DELETED }}
      </p>
      <audio
        v-else
        controls
        class="w-full max-w-md"
        :src="clip.url"
        :aria-label="clip.name ?? languages.SESSION_TURN_INPUT_AUDIO"
      />
    </template>
    <Collapsible v-if="prompt.agentRun" v-model:open="runPromptOpen" class="flex flex-col gap-2">
      <CollapsibleTrigger
        class="flex items-center gap-1.5 self-start rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <ChevronRightIcon
          class="size-3.5 flex-none text-muted-foreground transition-transform"
          :class="{ 'rotate-90': runPromptOpen }"
          aria-hidden="true"
        />
        <span>{{ runLabel(prompt.agentRun) }}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div class="rounded-md border border-border px-3 py-2 text-sm">
          <MarkdownRenderer :content="prompt.agentRun.prompt" :on-copy="copyText" />
        </div>
      </CollapsibleContent>
    </Collapsible>
    <template v-if="editing">
      <Textarea
        ref="editor"
        v-model="draft"
        class="text-sm"
        @keydown.enter.exact.prevent="submitEditFromKeyboard"
        @keydown.escape.prevent="emit('cancelEdit')"
      />
      <div class="flex items-center gap-2 self-end">
        <Button
          variant="secondary"
          size="sm"
          class="h-6 px-2 text-xs"
          :disabled="submitting"
          @click="emit('cancelEdit')"
        >
          {{ languages.COM_CANCEL }}
        </Button>
        <Button
          size="sm"
          class="h-6 px-2 text-xs"
          :disabled="submitting || !draft.trim()"
          @click="emit('editPrompt', draft)"
        >
          <PaperAirplaneIcon class="size-3.5" aria-hidden="true" />
          {{ languages.COM_SEND }}
        </Button>
      </div>
    </template>
    <MarkdownRenderer v-else-if="prompt.text" :content="prompt.text" :on-copy="copyText" />
    <p v-else-if="prompt.placeholder" class="text-muted-foreground italic">
      {{ prompt.placeholder }}
    </p>
    <div
      v-if="!editing && (prompt.text || prompt.origin || controls || canEdit)"
      class="flex items-center gap-3 text-xs text-muted-foreground"
    >
      <button v-if="prompt.text" class="flex items-center gap-1" @click="copyText(prompt.text)">
        <DocumentDuplicateIcon class="size-4" aria-hidden="true" />
        <span>{{ languages.COM_COPY }}</span>
      </button>
      <button v-if="canEdit" class="flex items-center gap-1" @click="emit('edit')">
        <PencilSquareIcon class="size-4" aria-hidden="true" />
        <span>{{ languages.COM_EDIT }}</span>
      </button>
      <button v-if="controls" class="flex items-center gap-1" @click="emit('editAgent')">
        <PencilSquareIcon class="size-4" aria-hidden="true" />
        <span>{{ languages.AGENT_LIBRARY_EDIT_AGENT }}</span>
      </button>
      <span
        v-if="prompt.origin"
        role="note"
        :aria-label="withChannel(languages.AGENT_ANSWER_VIA_LABEL, prompt.origin)"
        class="ml-auto inline-flex items-center gap-1"
      >
        <DevicePhoneMobileIcon class="size-3.5" aria-hidden="true" />
        {{ withChannel(languages.AGENT_ANSWER_VIA, prompt.origin) }}
      </span>
    </div>
    <template #aside>
      <span
        v-if="queued"
        role="status"
        class="self-center inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
      >
        <ClockIcon class="size-3.5" aria-hidden="true" />
        {{ languages.AGENT_TURN_QUEUED }}
      </span>
      <div
        v-else-if="notRun"
        class="self-center flex items-center gap-2 text-xs text-muted-foreground"
      >
        <span
          role="status"
          class="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5"
        >
          <ExclamationCircleIcon class="size-3.5" aria-hidden="true" />
          {{ languages.AGENT_TURN_NOT_RUN }}
        </span>
        <Button
          v-if="canResend"
          variant="secondary"
          size="sm"
          class="h-6 px-2 text-xs"
          @click="emit('resend')"
        >
          <ArrowPathIcon class="size-3.5" aria-hidden="true" />
          {{ languages.AGENT_TURN_RESEND }}
        </Button>
      </div>
    </template>
  </SessionUserBubble>
</template>

<script setup lang="ts">
import {
  ArrowPathIcon,
  ChevronRightIcon,
  ClockIcon,
  DocumentDuplicateIcon,
  DevicePhoneMobileIcon,
  ExclamationCircleIcon,
  PaperAirplaneIcon,
  PencilSquareIcon,
} from '@heroicons/vue/24/outline'
import { computed, nextTick, ref, watch } from 'vue'
import { getDescriptor } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { useI18N } from '@/assets/js/store/i18n'
import { useSessions } from '@/assets/js/store/sessions'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import SessionUserBubble from '@/components/SessionUserBubble.vue'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Textarea } from '@/components/ui/textarea'
import { copyToClipboard } from '@/lib/chatMessageText'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentRunControls } from '@/lib/sessionTimeline'
import { formatRunTime } from '@/lib/taskSchedule'
import type { AgentRunIdentity, TurnPrompt } from '@/lib/turnTypes'

const props = defineProps<{
  prompt: TurnPrompt
  queued?: boolean
  notRun?: boolean
  canResend?: boolean
  controls?: AgentRunControls | null
  /** The prompt bubble as an editor: its text re-runs the turn when sent. */
  editing?: boolean
  submitting?: boolean
}>()

const emit = defineEmits<{
  resend: []
  editAgent: []
  edit: []
  cancelEdit: []
  editPrompt: [text: string]
}>()

const sessions = useSessions()
const i18nStore = useI18N()
const languages = i18nStore.state
const runPromptOpen = ref(false)

/** The timeline marks a re-runnable prompt editable; a busy turn hides the affordance. */
const canEdit = computed(() => !!props.prompt.editable && !props.submitting)

const draft = ref('')
const editor = ref<{ $el: HTMLTextAreaElement } | null>(null)

watch(
  () => props.editing,
  async (editing) => {
    if (!editing) return
    draft.value = props.prompt.text
    // The textarea arrives with the editor; put the caret where the edit starts.
    await nextTick()
    editor.value?.$el.focus()
  },
  { immediate: true },
)

function runLabel(run: AgentRunIdentity): string {
  if (run.trigger === 'manual')
    return fillTemplate(languages.AGENT_RUN_PROMPT_MANUAL, { name: run.name })
  if (run.trigger === 'channel' && run.channel) {
    const channel = getDescriptor(run.channel)?.displayName ?? run.channel
    return fillTemplate(languages.AGENT_RUN_PROMPT_CHANNEL, { name: run.name, channel })
  }
  const time = formatRunTime(run.startedAt, i18nStore.langName)
  return fillTemplate(languages.AGENT_RUN_PROMPT_SCHEDULED, { time })
}

function copyText(value: string) {
  copyToClipboard(value, languages.COM_COPY_SUCCESS_TIP)
}

function submitEditFromKeyboard(): void {
  if (props.submitting || !draft.value.trim()) return
  emit('editPrompt', draft.value)
}

function withChannel(template: string, channel: ChannelKind): string {
  const name = getDescriptor(channel)?.displayName ?? channel
  return fillTemplate(template, { channel: name })
}
</script>
