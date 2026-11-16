<template>
  <aside
    :aria-label="languages.SETTINGS_THEME_PANEL_TITLE"
    class="flex w-[min(380px,45vw)] min-w-64 shrink-0 flex-col border-l border-border bg-card text-foreground"
  >
    <div class="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <h2 class="text-base font-semibold">{{ languages.SETTINGS_THEME_PANEL_TITLE }}</h2>
      <Button
        variant="ghost"
        size="icon"
        class="h-8 w-8"
        :aria-label="languages.COM_CLOSE"
        @click="ui.closeThemePanel()"
      >
        <XMarkIcon class="size-5" />
      </Button>
    </div>
    <ThemeEditor class="flex-1" />
  </aside>
</template>

<script setup lang="ts">
import { XMarkIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { useTheme } from '@/assets/js/store/theme'
import { useUIStore } from '@/assets/js/store/ui'
import ThemeEditor from '@/components/ThemeEditor.vue'
import { Button } from '@/components/ui/button'

const languages = useI18N().state
const theme = useTheme()
const ui = useUIStore()

ui.setThemePanelLeaveGuard(theme.guardUnsaved)
</script>
