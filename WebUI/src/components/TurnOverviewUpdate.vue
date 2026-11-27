<template>
  <div class="flex flex-col gap-1 text-xs">
    <p class="text-muted-foreground">
      <span class="font-medium">{{ languages.SESSION_OVERVIEW_UPDATE_TITLE }}</span>
      <span> · {{ statusText }}</span>
      <span v-if="update.model">
        · {{ fillTemplate(languages.SESSION_OVERVIEW_UPDATE_MODEL, { model: update.model }) }}
      </span>
      <span v-if="moment"> · {{ moment }}</span>
      <span v-if="duration"> · {{ duration }}</span>
      <span v-if="update.tokens !== undefined">
        · {{ fillTemplate(languages.SESSION_OVERVIEW_UPDATE_TOKENS, { count: update.tokens }) }}
      </span>
      <span v-if="coveredLabel">
        · {{ fillTemplate(languages.SESSION_OVERVIEW_UPDATE_COVERED, { entry: coveredLabel }) }}
      </span>
    </p>
    <p v-if="update.text" class="whitespace-pre-wrap wrap-break-word">{{ update.text }}</p>
    <p v-if="update.state === 'failed'">
      <button
        type="button"
        class="text-xs font-medium text-primary underline-offset-2 hover:underline disabled:opacity-50"
        :disabled="busy"
        @click="retry"
      >
        {{ languages.SESSION_OVERVIEW_UPDATE_RETRY }}
      </button>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { fillTemplate } from '@/lib/fillTemplate'
import { useSessionOverviews } from '@/lib/useSessionOverviews'
import type { OverviewSummaryUpdate } from '@/types/sessionIpc'

const props = defineProps<{
  entryId: string
  update: OverviewSummaryUpdate
  covered?: { at: number; number: number }
}>()

const i18n = useI18N()
const languages = i18n.state
const overviews = useSessionOverviews()
const busy = ref(false)

async function retry(): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    await overviews.retryUpdate(props.entryId)
  } finally {
    busy.value = false
  }
}

const statusText = computed(() => {
  const update = props.update
  if (update.state === 'ready') return languages.SESSION_OVERVIEW_UPDATE_READY
  if (update.state === 'skipped') return languages.SESSION_OVERVIEW_UPDATE_SKIPPED
  if (update.state === 'failed') {
    return fillTemplate(languages.SESSION_OVERVIEW_UPDATE_FAILED, {
      reason: update.failureReason ?? '',
    })
  }
  return languages.SESSION_OVERVIEW_UPDATE_PENDING
})

const moment = computed(() =>
  props.update.state === 'ready' && props.update.writtenAt !== undefined
    ? new Intl.DateTimeFormat(i18n.langName, { timeStyle: 'short' }).format(
        new Date(props.update.writtenAt),
      )
    : undefined,
)

const duration = computed(() => {
  const ms = props.update.durationMs
  if (ms === undefined) return undefined
  const seconds = ms >= 1000
  return new Intl.NumberFormat(i18n.langName, {
    style: 'unit',
    unit: seconds ? 'second' : 'millisecond',
    unitDisplay: 'short',
    maximumFractionDigits: 1,
  }).format(seconds ? ms / 1000 : ms)
})

const coveredLabel = computed(() => {
  const covered = props.covered
  if (!covered) return undefined
  const at = new Intl.DateTimeFormat(i18n.langName, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(covered.at))
  return `${covered.number} · ${at}`
})
</script>
