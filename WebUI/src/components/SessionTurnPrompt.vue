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
    <p v-if="prompt.agentRun">{{ runLabel(prompt.agentRun) }}</p>
    <div v-if="controls" class="flex items-center gap-2">
      <Button
        v-if="controls.stoppable"
        variant="secondary"
        size="sm"
        class="h-7 px-2 text-xs"
        @click="emit('stop')"
      >
        <StopIcon class="size-3.5" aria-hidden="true" />
        {{ languages.COM_STOP }}
      </Button>
      <Button variant="ghost" size="sm" class="h-7 px-2 text-xs" @click="emit('editAgent')">
        <PencilSquareIcon class="size-3.5" aria-hidden="true" />
        {{ languages.AGENT_LIBRARY_EDIT_AGENT }}
      </Button>
    </div>
    <MarkdownRenderer v-if="prompt.text" :content="prompt.text" :on-copy="copyText" />
    <p v-else-if="prompt.placeholder" class="text-muted-foreground italic">
      {{ prompt.placeholder }}
    </p>
    <div
      v-if="prompt.text || prompt.origin"
      class="flex items-center gap-3 text-xs text-muted-foreground"
    >
      <button v-if="prompt.text" class="flex items-center gap-1" @click="copyText(prompt.text)">
        <DocumentDuplicateIcon class="size-4" aria-hidden="true" />
        <span>{{ languages.COM_COPY }}</span>
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
  ClockIcon,
  DocumentDuplicateIcon,
  DevicePhoneMobileIcon,
  ExclamationCircleIcon,
  PencilSquareIcon,
  StopIcon,
} from '@heroicons/vue/24/outline'
import { getDescriptor } from '@/assets/js/store/channels/channelRegistry'
import type { ChannelKind } from '@/assets/js/store/channels/types'
import { useI18N } from '@/assets/js/store/i18n'
import { useSessions } from '@/assets/js/store/sessions'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import SessionUserBubble from '@/components/SessionUserBubble.vue'
import { Button } from '@/components/ui/button'
import { copyToClipboard } from '@/lib/chatMessageText'
import { fillTemplate } from '@/lib/fillTemplate'
import type { AgentRunControls } from '@/lib/sessionTimeline'
import { formatRunTime } from '@/lib/taskSchedule'
import type { AgentRunIdentity, TurnPrompt } from '@/lib/turnTypes'

defineProps<{
  prompt: TurnPrompt
  queued?: boolean
  notRun?: boolean
  canResend?: boolean
  controls?: AgentRunControls | null
}>()

const emit = defineEmits<{ resend: []; stop: []; editAgent: [] }>()

const sessions = useSessions()
const i18nStore = useI18N()
const languages = i18nStore.state

function runLabel(run: AgentRunIdentity): string {
  if (run.trigger === 'manual')
    return fillTemplate(languages.AGENT_RUN_PROMPT_MANUAL, { name: run.name })
  const time = formatRunTime(run.startedAt, i18nStore.langName)
  return fillTemplate(languages.AGENT_RUN_PROMPT_SCHEDULED, { time })
}

function copyText(value: string) {
  copyToClipboard(value, languages.COM_COPY_SUCCESS_TIP)
}

function withChannel(template: string, channel: ChannelKind): string {
  const name = getDescriptor(channel)?.displayName ?? channel
  return fillTemplate(template, { channel: name })
}
</script>
