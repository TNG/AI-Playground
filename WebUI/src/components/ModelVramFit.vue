<script setup lang="ts">
import { computed } from 'vue'
import { PuzzlePieceIcon } from '@heroicons/vue/24/outline'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useI18N } from '@/assets/js/store/i18n'
import { formatBytes } from '@/assets/js/models/library'
import { useLlamaCppVramFit, type VramFitPoint, type VramFitTarget } from '@/lib/useLlamaCppVramFit'
import type { VramFitLevel, VramFitVerdict } from '@/lib/vram'

const props = withDefaults(
  defineProps<{
    /**
     * Defaults to the active model; pass one to judge a model in a list. Already
     * narrowed to llama.cpp by the caller (`llamaCppFitTarget`), since only the
     * caller knows which backend the row it is rendering belongs to.
     */
    model?: VramFitTarget
    iconSize?: string
    delayDuration?: number
  }>(),
  { model: undefined, iconSize: 'size-4', delayDuration: 200 },
)

const i18nState = useI18N().state
const { summary, verdict } = useLlamaCppVramFit(
  props.model ? computed(() => props.model) : undefined,
)

// Orange, not red: the model may well fit. What is wrong is that we cannot say,
// which is its own state and reads as one next to the three that are an answer.
const LEVEL_COLOR: Record<VramFitVerdict, string> = {
  easy: 'text-green-500',
  tight: 'text-yellow-500',
  over: 'text-destructive',
  unknown: 'text-orange-500',
}

const LEVEL_KEY: Record<VramFitVerdict, string> = {
  easy: 'VRAM_FIT_LEVEL_EASY',
  tight: 'VRAM_FIT_LEVEL_TIGHT',
  over: 'VRAM_FIT_LEVEL_OVER',
  unknown: 'VRAM_FIT_LEVEL_UNKNOWN',
}

function t(key: string, vars: Record<string, string> = {}): string {
  return Object.entries(vars).reduce(
    (text, [name, value]) => text.replace(`{${name}}`, value),
    i18nState[key] ?? '',
  )
}

const tokens = (count: number) => new Intl.NumberFormat().format(count)

const levelLabel = computed(() => (verdict.value ? t(LEVEL_KEY[verdict.value]) : ''))

const budgetLine = computed(() =>
  summary.value
    ? t('VRAM_FIT_BUDGET', {
        available: formatBytes(summary.value.availableBytes),
        max: formatBytes(summary.value.totalBytes),
      })
    : '',
)

// Current, the shared 8k reference and the model's ceiling — skipping any that
// would repeat a context size already listed.
const rows = computed(() => {
  const fit = summary.value
  if (!fit) return []
  const listed = new Set<number>()
  const entries: { label: string; breakdown: string; level: VramFitLevel }[] = []
  const add = (labelKey: string, point: VramFitPoint) => {
    if (listed.has(point.contextTokens)) return
    listed.add(point.contextTokens)
    entries.push({
      label: t(labelKey, { tokens: tokens(point.contextTokens) }),
      breakdown: t('VRAM_FIT_BREAKDOWN', {
        base: formatBytes(point.baseBytes),
        context: formatBytes(point.contextBytes),
        total: formatBytes(point.totalBytes),
      }),
      level: point.level,
    })
  }
  add('VRAM_FIT_AT_CURRENT', fit.current)
  add('VRAM_FIT_AT_REFERENCE', fit.reference)
  add('VRAM_FIT_AT_MAX', fit.max)
  return entries
})
</script>

<template>
  <TooltipProvider v-if="verdict">
    <Tooltip :delay-duration="delayDuration">
      <TooltipTrigger as-child>
        <!-- A row of the picker is itself the control: a nested button would take
             the menu's focus and swallow the click that selects the model. -->
        <component
          :is="model ? 'span' : 'button'"
          :type="model ? undefined : 'button'"
          :role="model ? 'img' : undefined"
          class="flex flex-none items-center cursor-help"
          :aria-label="t('VRAM_FIT_ARIA', { level: levelLabel })"
        >
          <PuzzlePieceIcon :class="[iconSize, LEVEL_COLOR[verdict]]" />
        </component>
      </TooltipTrigger>
      <TooltipContent
        align="start"
        class="w-64 bg-card border border-border text-foreground p-3 z-[200]"
      >
        <p class="text-sm font-semibold">{{ t('VRAM_FIT_TITLE') }}</p>
        <p class="text-xs" :class="LEVEL_COLOR[verdict]">{{ levelLabel }}</p>
        <!-- Nothing was measured, so there is no budget line and no breakdown to
             show — only why the estimate is missing. -->
        <p v-if="!summary" class="mt-1 text-xs text-muted-foreground">
          {{ t('VRAM_FIT_UNKNOWN_EXPLANATION') }}
        </p>
        <template v-else>
          <p class="mt-1 text-xs text-muted-foreground">{{ budgetLine }}</p>
          <div class="mt-2 space-y-1">
            <div v-for="row in rows" :key="row.label">
              <p class="text-xs" :class="LEVEL_COLOR[row.level]">{{ row.label }}</p>
              <p class="text-xs text-muted-foreground">{{ row.breakdown }}</p>
            </div>
          </div>
          <p class="mt-2 text-xs text-muted-foreground">{{ t('VRAM_FIT_EXPLANATION') }}</p>
        </template>
      </TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>
