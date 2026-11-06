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
              <DropdownMenuRadioGroup :model-value="theme.active" @update:model-value="selectTheme">
                <DropdownMenuRadioItem v-for="t in theme.availableThemes" :key="t" :value="t">
                  {{ themeDisplayName[t] }}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
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
import { useTheme } from '@/assets/js/store/theme'
import { useI18N } from '@/assets/js/store/i18n'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const theme = useTheme()
const languages = useI18N().state

function selectTheme(value: unknown) {
  const match = theme.availableThemes.find((t) => t === value)
  if (match) theme.selected = match
}

const themeDisplayName: Record<Theme, string> = {
  dark: 'Default',
  lnl: 'Intel® Core™ Ultra',
  bmg: 'Intel® Arc™',
  light: 'Light',
}
</script>
