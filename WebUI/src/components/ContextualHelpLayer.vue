<template>
  <Teleport to="body">
    <div
      v-if="contextualHelp.active"
      id="contextual-help-panel"
      class="pointer-events-none fixed inset-0 z-[40015]"
      aria-live="polite"
    >
      <div
        v-if="!contextualHelp.panelTopic"
        class="pointer-events-none fixed bottom-24 left-1/2 z-[40016] max-w-md -translate-x-1/2 rounded-lg border border-border bg-popover px-4 py-2 text-center text-sm text-popover-foreground shadow-lg"
      >
        Help mode — click a control to learn about it. Press Esc to exit.
      </div>
      <div
        v-if="contextualHelp.panelTopic && contextualHelp.anchor"
        class="pointer-events-auto fixed z-[40020] w-[min(22rem,calc(100vw-2rem))] rounded-lg border border-border bg-popover p-4 text-popover-foreground shadow-xl"
        :style="panelStyle"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="headingId"
      >
        <h2 :id="headingId" class="mb-2 text-base font-semibold">
          {{ contextualHelp.panelTopic.title }}
        </h2>
        <p class="text-sm leading-relaxed text-muted-foreground">
          {{ contextualHelp.panelTopic.body }}
        </p>
        <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            class="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
            @click="contextualHelp.closePanel()"
          >
            Got it
          </button>
          <button
            type="button"
            class="text-xs text-muted-foreground underline-offset-2 hover:underline"
            @click="contextualHelp.deactivate()"
          >
            Exit help mode
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, watch } from 'vue'
import { resolveHelpTarget } from '@/assets/js/help/helpTopics'
import { useContextualHelp } from '@/assets/js/store/contextualHelp'
import * as toast from '@/assets/js/toast'

const contextualHelp = useContextualHelp()
const headingId = 'contextual-help-heading'

const HIGHLIGHT_CLASS = 'aipg-help-highlight'
let highlightedEl: HTMLElement | null = null

const panelStyle = computed(() => {
  const a = contextualHelp.anchor
  if (!a) return {}
  const margin = 8
  const panelW = Math.min(352, window.innerWidth - 32)
  let top = a.top - margin
  let left = a.left + a.width / 2 - panelW / 2
  left = Math.max(16, Math.min(left, window.innerWidth - panelW - 16))
  const estimatedHeight = 160
  if (top - estimatedHeight < 16) {
    top = a.top + a.height + margin
  } else {
    top = a.top - estimatedHeight - margin
  }
  return {
    top: `${Math.max(16, top)}px`,
    left: `${left}px`,
  }
})

function clearHighlight() {
  if (highlightedEl) {
    highlightedEl.classList.remove(HIGHLIGHT_CLASS)
    highlightedEl = null
  }
}

function setHighlight(el: HTMLElement | null) {
  if (highlightedEl === el) return
  clearHighlight()
  if (el) {
    el.classList.add(HIGHLIGHT_CLASS)
    highlightedEl = el
  }
}

function onCaptureClick(event: MouseEvent) {
  if (!contextualHelp.active) return
  const target = event.target
  if (target instanceof HTMLElement && target.closest('#contextual-help-panel')) {
    return
  }
  if (target instanceof HTMLElement && target.closest('#contextual-help-toggle')) {
    return
  }

  event.preventDefault()
  event.stopPropagation()

  const resolved = resolveHelpTarget(target)
  if (resolved) {
    contextualHelp.openPanel(resolved.topicId, resolved.element)
    setHighlight(resolved.element)
    return
  }

  toast.show('No help topic here — try the prompt bar, mode buttons, or settings icons.')
}

function onCaptureMouseMove(event: MouseEvent) {
  if (!contextualHelp.active || contextualHelp.panelTopicId) return
  const target = event.target
  if (!(target instanceof HTMLElement)) {
    setHighlight(null)
    return
  }
  const resolved = resolveHelpTarget(target)
  setHighlight(resolved?.element ?? null)
}

function onKeyDown(event: KeyboardEvent) {
  if (!contextualHelp.active || event.key !== 'Escape') return
  event.preventDefault()
  if (contextualHelp.panelTopicId) contextualHelp.closePanel()
  else contextualHelp.deactivate()
}

function bindListeners() {
  document.body.classList.add('aipg-help-mode')
  document.addEventListener('click', onCaptureClick, true)
  document.addEventListener('mousemove', onCaptureMouseMove, true)
  document.addEventListener('keydown', onKeyDown, true)
}

function unbindListeners() {
  document.body.classList.remove('aipg-help-mode')
  document.removeEventListener('click', onCaptureClick, true)
  document.removeEventListener('mousemove', onCaptureMouseMove, true)
  document.removeEventListener('keydown', onKeyDown, true)
  clearHighlight()
}

watch(
  () => contextualHelp.active,
  (on) => {
    if (on) bindListeners()
    else unbindListeners()
  },
)

watch(
  () => contextualHelp.panelTopicId,
  (id) => {
    if (!id) clearHighlight()
  },
)

onBeforeUnmount(() => {
  if (contextualHelp.active) contextualHelp.deactivate()
  else unbindListeners()
})
</script>

<style>
body.aipg-help-mode {
  cursor: help;
}

body.aipg-help-mode button:not(#contextual-help-toggle),
body.aipg-help-mode a,
body.aipg-help-mode textarea,
body.aipg-help-mode [data-aipg-help],
body.aipg-help-mode #prompt-input,
body.aipg-help-mode #plus-icon,
body.aipg-help-mode #mode-buttons,
body.aipg-help-mode [id^='mode-button-'],
body.aipg-help-mode #send-button,
body.aipg-help-mode #camera-button,
body.aipg-help-mode #microphone-button,
body.aipg-help-mode #advanced-settings-button,
body.aipg-help-mode #app-settings-button,
body.aipg-help-mode #show-history-button,
body.aipg-help-mode #app-settings-sidebar,
body.aipg-help-mode #advanced-settings-sidebar {
  cursor: help;
}

.aipg-help-highlight {
  outline: 2px solid hsl(var(--primary));
  outline-offset: 2px;
  border-radius: 4px;
}
</style>
