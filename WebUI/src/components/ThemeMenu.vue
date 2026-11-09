<template>
  <TooltipProvider :delay-duration="200">
    <!-- reka's popper context is a plain provide/inject, so a menu trigger nested inside
         a Tooltip anchors the tooltip, not the menu; keep the DropdownMenu innermost. -->
    <Tooltip>
      <TooltipTrigger as-child>
        <span class="inline-flex">
          <DropdownMenu>
            <DropdownMenuTrigger as-child>
              <button id="theme-button" type="button" :aria-label="languages.COM_THEME">
                <SwatchIcon class="size-6 text-foreground"></SwatchIcon>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" class="min-w-48">
              <DropdownMenuRadioGroup
                :model-value="theme.selectedId"
                @update:model-value="selectTheme"
              >
                <DropdownMenuRadioItem v-for="t in theme.builtInThemes" :key="t.id" :value="t.id">
                  {{ t.name }}
                </DropdownMenuRadioItem>
                <DropdownMenuSeparator v-if="theme.validCustomThemes.length" />
                <DropdownMenuRadioItem
                  v-for="t in theme.validCustomThemes"
                  :key="t.id"
                  :value="t.id"
                >
                  {{ t.name }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
              <template v-if="canCustomize && !demoMode.enabled">
                <DropdownMenuSeparator />
                <DropdownMenuItem @select="emit('customize')">
                  <PaintBrushIcon />
                  {{ languages.THEME_CUSTOMIZE }}
                </DropdownMenuItem>
              </template>
            </DropdownMenuContent>
          </DropdownMenu>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ languages.COM_THEME }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { SwatchIcon } from '@heroicons/vue/24/solid'
import { PaintBrushIcon } from '@heroicons/vue/24/outline'
import { useTheme } from '@/assets/js/store/theme'
import { useI18N } from '@/assets/js/store/i18n'
import { useDemoMode } from '@/assets/js/store/demoMode'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

defineProps<{ canCustomize: boolean }>()
const emit = defineEmits<{ customize: [] }>()

const theme = useTheme()
const demoMode = useDemoMode()
const languages = useI18N().state

function selectTheme(value: unknown) {
  if (typeof value === 'string') theme.guardUnsaved(() => theme.selectTheme(value))
}
</script>
