<template>
  <Collapsible v-model:open="open" class="flex flex-col gap-2">
    <div class="flex min-w-0 items-center gap-3">
      <img
        :class="textInference.iconSizeClass"
        class="shrink-0"
        src="../assets/svg/ai-icon.svg"
        alt=""
      />
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <p class="flex-none text-muted-foreground" :class="textInference.nameSizeClass">
          {{ languages.ANSWER_AI_NAME }}
        </p>
        <span class="text-xs text-muted-foreground" aria-hidden="true">·</span>
        <SessionTurnHint :hint="hint" />
        <template v-if="turnDetailsShown(details)">
          <span class="text-xs text-muted-foreground" aria-hidden="true">·</span>
          <CollapsibleTrigger as-child>
            <TurnDetailsHeader
              :summary="details.summary"
              :live="details.live"
              :progress="details.progress"
              :open="open"
            />
          </CollapsibleTrigger>
        </template>
        <button
          v-if="details.live?.kind === 'activity' && details.live.browsing"
          type="button"
          class="flex-none rounded border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          @click="toggleBrowserWindow"
        >
          {{
            webBrowser.isVisible
              ? languages.SESSION_TURN_HIDE_BROWSER
              : languages.SESSION_TURN_SHOW_BROWSER
          }}
        </button>
      </div>
    </div>
    <div v-if="belowHeader" class="flex items-start gap-3">
      <span :class="textInference.iconSizeClass" class="shrink-0" aria-hidden="true" />
      <div class="flex min-w-0 flex-1 flex-col gap-2">
        <div
          v-if="details.errorLine && !details.live && !open"
          class="truncate text-sm text-destructive"
        >
          {{ details.errorLine }}
        </div>
        <slot name="status" />
        <CollapsibleContent>
          <div class="flex flex-col gap-3 border-l-2 border-border pl-4">
            <slot />
            <p
              v-if="details.error"
              class="text-sm text-destructive whitespace-pre-wrap wrap-break-word"
            >
              {{ details.error }}
            </p>
          </div>
        </CollapsibleContent>
      </div>
    </div>
  </Collapsible>
</template>

<script setup lang="ts">
import { computed, ref, useSlots } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useTextInference } from '@/assets/js/store/textInference'
import { useWebBrowser } from '@/assets/js/store/webBrowser'
import SessionTurnHint from '@/components/SessionTurnHint.vue'
import TurnDetailsHeader from '@/components/TurnDetailsHeader.vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { turnDetailsShown } from '@/lib/turnText'
import type { TurnDetails, TurnHint } from '@/lib/turnTypes'

const props = defineProps<{ details: TurnDetails; hint: TurnHint }>()
const slots = useSlots()

const textInference = useTextInference()
const webBrowser = useWebBrowser()
const languages = useI18N().state
const open = ref(false)

const belowHeader = computed(
  () => open.value || !!slots.status || (!!props.details.errorLine && !props.details.live),
)

function toggleBrowserWindow() {
  if (webBrowser.isVisible) void webBrowser.hide()
  else void webBrowser.show()
}
</script>
