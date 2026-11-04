<template>
  <div v-if="turnDetailsShown(details) || $slots.status" class="flex items-start gap-3">
    <span :class="textInference.iconSizeClass" class="shrink-0" aria-hidden="true" />
    <Collapsible v-model:open="open" class="flex min-w-0 flex-1 flex-col gap-2">
      <div v-if="turnDetailsShown(details)" class="flex min-w-0 items-center gap-2">
        <CollapsibleTrigger as-child>
          <TurnDetailsHeader :summary="details.summary" :live="details.live" :open="open" />
        </CollapsibleTrigger>
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
    </Collapsible>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useTextInference } from '@/assets/js/store/textInference'
import { useWebBrowser } from '@/assets/js/store/webBrowser'
import TurnDetailsHeader from '@/components/TurnDetailsHeader.vue'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { turnDetailsShown } from '@/lib/turnText'
import type { TurnDetails } from '@/lib/turnTypes'

defineProps<{ details: TurnDetails }>()

const textInference = useTextInference()
const webBrowser = useWebBrowser()
const languages = useI18N().state
const open = ref(false)

function toggleBrowserWindow() {
  if (webBrowser.isVisible) void webBrowser.hide()
  else void webBrowser.show()
}
</script>
