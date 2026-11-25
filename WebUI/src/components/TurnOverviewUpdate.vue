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
      <span v-if="shortCovered">
        · {{ fillTemplate(languages.SESSION_OVERVIEW_UPDATE_COVERED, { entry: shortCovered }) }}
      </span>
    </p>
    <p v-if="update.text" class="whitespace-pre-wrap wrap-break-word">{{ update.text }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { fillTemplate } from '@/lib/fillTemplate'
import type { OverviewSummaryUpdate } from '@/types/sessionIpc'

const props = defineProps<{ update: OverviewSummaryUpdate }>()

const languages = useI18N().state

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
    ? new Date(props.update.writtenAt).toLocaleTimeString()
    : undefined,
)

const duration = computed(() => {
  const ms = props.update.durationMs
  if (ms === undefined) return undefined
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
})

const shortCovered = computed(() => {
  const id = props.update.coveredEntryId
  return id ? id.replace(/^entry-/, '').slice(-8) : undefined
})
</script>
