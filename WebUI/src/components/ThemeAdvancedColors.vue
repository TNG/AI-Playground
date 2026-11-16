<template>
  <div role="group" class="flex flex-col gap-4">
    <section
      v-for="group in advancedGroups"
      :key="group.id"
      class="flex flex-col gap-1.5"
      :aria-labelledby="`theme-group-${group.id}`"
    >
      <h3 :id="`theme-group-${group.id}`" class="text-xs font-medium text-muted-foreground">
        {{ languages[groupLabelKeys[group.id]] }}
      </h3>
      <ul class="flex flex-col gap-2 pl-1">
        <li
          v-for="row in group.rows"
          :key="row.surface"
          role="group"
          :aria-label="rowTokens(row).map(label).join(' / ')"
          class="flex items-center gap-3"
        >
          <div
            class="flex h-9 w-20 shrink-0 items-center justify-center rounded-md border border-border text-xs"
            :style="{ backgroundColor: colors.background }"
            aria-hidden="true"
          >
            <span
              v-if="row.sample === 'text'"
              class="rounded px-2 py-1 font-medium"
              :style="{ backgroundColor: colors[row.surface], color: colorOf(row.text) }"
              >Aa</span
            >
            <span
              v-else-if="row.sample === 'menu-row'"
              class="flex w-16 flex-col rounded p-0.5"
              :style="{ backgroundColor: colors.popover, color: colors['popover-foreground'] }"
            >
              <span class="rounded px-1 leading-tight">Aa</span>
              <span
                class="rounded px-1 leading-tight"
                :style="{ backgroundColor: colors[row.surface], color: colorOf(row.text) }"
                >Aa</span
              >
            </span>
            <span
              v-else-if="row.sample === 'focused-field'"
              class="h-5 w-14 rounded border"
              :style="{
                borderColor: colors.input,
                boxShadow: `0 0 0 2px ${colors[row.surface]}`,
              }"
            />
            <span
              v-else-if="row.sample === 'line'"
              class="h-5 w-14 rounded border-2"
              :style="{ borderColor: colors[row.surface] }"
            />
            <span
              v-else-if="row.sample === 'badge'"
              class="rounded-full px-2 py-0.5 font-medium"
              :style="{ backgroundColor: colors[row.surface], color: colorOf(row.text) }"
              >Aa</span
            >
            <span
              v-else-if="row.sample === 'notice'"
              class="flex items-center gap-1 rounded border px-1.5 py-0.5"
              :style="{
                borderColor: `${colors[row.surface]}80`,
                backgroundColor: `${colors[row.surface]}1a`,
                color: colors[row.surface],
              }"
            >
              <ExclamationTriangleIcon class="size-3.5" />Aa
            </span>
            <CheckCircleIcon
              v-else-if="row.sample === 'tick'"
              class="size-5"
              :style="{ color: colors[row.surface] }"
            />
          </div>

          <div class="flex min-w-0 flex-1 flex-col gap-1">
            <div
              v-for="token in rowTokens(row)"
              :key="token"
              class="flex items-center justify-between gap-2"
            >
              <Label :for="`theme-token-${token}`" class="flex flex-col items-start gap-0 text-xs">
                {{ label(token) }}
                <span class="font-mono text-[10px] font-normal text-muted-foreground">{{
                  token
                }}</span>
              </Label>
              <input
                :id="`theme-token-${token}`"
                type="color"
                class="size-7 shrink-0 cursor-pointer rounded-sm border border-border bg-transparent p-0"
                :value="colors[token]"
                @input="(e) => theme.setColor(token, (e.target as HTMLInputElement).value)"
              />
            </div>
          </div>

          <div class="flex w-20 shrink-0 flex-col items-end text-xs">
            <template v-if="contrastOf(row)">
              <span
                class="font-mono"
                :class="contrastOf(row)!.readable ? 'text-muted-foreground' : 'text-destructive'"
                :aria-label="
                  fillTemplate(languages.SETTINGS_THEME_CONTRAST, {
                    ratio: formatContrastRatio(contrastOf(row)!.ratio),
                  })
                "
                >{{ formatContrastRatio(contrastOf(row)!.ratio) }}:1</span
              >
              <span
                v-if="!contrastOf(row)!.readable"
                class="flex items-center gap-1 text-destructive"
              >
                <ExclamationTriangleIcon class="size-3.5" />
                {{ languages.SETTINGS_THEME_LOW_CONTRAST }}
              </span>
            </template>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { CheckCircleIcon, ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import { useTheme } from '@/assets/js/store/theme'
import { useI18N } from '@/assets/js/store/i18n'
import { Label } from '@/components/ui/label'
import type { ThemeToken } from '@/lib/builtInThemes'
import { fillTemplate } from '@/lib/fillTemplate'
import {
  advancedGroups,
  advancedRowContrast,
  colorLabelKeys,
  formatContrastRatio,
  groupLabelKeys,
  type AdvancedRow,
} from '@/lib/themeAdvancedGroups'

const theme = useTheme()
const languages = useI18N().state
const colors = computed(() => theme.draftHexColors)

const label = (token: ThemeToken) => languages[colorLabelKeys[token]]
const rowTokens = (row: AdvancedRow) => (row.text ? [row.surface, row.text] : [row.surface])
const colorOf = (token: ThemeToken | undefined) => (token ? colors.value[token] : undefined)
const contrastOf = (row: AdvancedRow) => advancedRowContrast(row, colors.value)
</script>
