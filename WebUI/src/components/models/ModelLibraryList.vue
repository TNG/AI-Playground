<script setup lang="ts">
import { computed } from 'vue'
import { ArrowDownTrayIcon, StarIcon } from '@heroicons/vue/24/solid'
import { StarIcon as StarOutlineIcon } from '@heroicons/vue/24/outline'
import { Checkbox } from '@/components/ui/checkbox'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import ModelVramFit from '@/components/ModelVramFit.vue'
import ModelRowActions from './ModelRowActions.vue'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import { useI18N } from '@/assets/js/store/i18n'
import { fillTemplate } from '@/lib/fillTemplate'
import { modelDetailsLine, usedBySummary } from '@/assets/js/models/library'
import type { ModelEntry } from '@/assets/js/models/types'

const emit = defineEmits<{
  (e: 'edit', entry: ModelEntry): void
  (e: 'delete', entry: ModelEntry): void
}>()

const library = useModelLibrary()
const i18n = useI18N()

const locale = computed(() => ({ strings: i18n.state, tag: i18n.langName }))

function rowLabel(key: string, entry: ModelEntry): string {
  return fillTemplate(i18n.state[key] ?? '', { label: entry.label })
}
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col px-6 pb-6">
    <label
      class="flex items-center gap-3 border-b border-border px-3 pb-2 text-xs text-muted-foreground"
    >
      <Checkbox
        :aria-label="languages.MODEL_MANAGER_SELECT_ALL"
        :model-value="library.allVisibleSelected"
        :disabled="library.visibleEntries.length === 0"
        @update:model-value="library.toggleSelectAllVisible()"
      />
      {{ languages.MODEL_MANAGER_SELECT_ALL }}
    </label>

    <TooltipProvider :delay-duration="200">
      <ul
        role="list"
        :aria-label="languages.SETTINGS_TAB_MODEL_LIBRARY"
        class="min-h-0 flex-1 overflow-y-auto divide-y divide-border"
      >
        <li
          v-for="entry in library.visibleEntries"
          :key="entry.id"
          :aria-label="entry.label"
          class="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/40"
        >
          <Checkbox
            :aria-label="rowLabel('MODEL_MANAGER_SELECT_MODEL', entry)"
            :model-value="library.selection.has(entry.id)"
            @update:model-value="library.toggleSelected(entry.id)"
          />
          <button
            type="button"
            :aria-label="
              entry.favorite
                ? `${languages.MODEL_MANAGER_ACTION_UNFAVORITE} ${entry.label}`
                : `${languages.MODEL_MANAGER_ACTION_FAVORITE} ${entry.label}`
            "
            class="-ml-1 flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted"
            @click="library.setFavorite(entry.id, !entry.favorite)"
          >
            <StarIcon v-if="entry.favorite" class="size-4 text-primary" />
            <StarOutlineIcon v-else class="size-4 text-muted-foreground" />
          </button>

          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <div class="flex min-w-0 items-center gap-2">
              <span class="truncate text-sm font-medium">{{ entry.label }}</span>
              <!-- Same chip as the chat picker, and absent on the same terms:
                   anything but a llama.cpp LLM has no estimate to show. -->
              <ModelVramFit :model="library.fitTargetFor(entry)" as="span" />
              <CapabilityIcons
                v-if="entry.useCase === 'llm'"
                :model="entry.capabilities"
                icon-size="size-3.5"
              />
            </div>
            <div class="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
              <span class="min-w-0 shrink-[3] truncate">{{
                modelDetailsLine(entry, library.filters.useCase, locale)
              }}</span>
              <Tooltip v-if="entry.requiredBy.length > 0">
                <TooltipTrigger as-child>
                  <span class="min-w-0 max-w-[50%] shrink cursor-default truncate">
                    · {{ languages.MODEL_MANAGER_USED_BY }} {{ usedBySummary(entry.requiredBy) }}
                  </span>
                </TooltipTrigger>
                <TooltipContent class="max-w-xs bg-card border border-border text-foreground p-2">
                  <p class="text-xs">{{ entry.requiredBy.join(', ') }}</p>
                </TooltipContent>
              </Tooltip>
            </div>
          </div>

          <span class="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <span
              class="size-2 rounded-full"
              :class="entry.downloaded ? 'bg-success' : 'bg-muted-foreground/40'"
            />
            {{
              entry.downloaded
                ? languages.MODEL_MANAGER_STATUS_ON_DISK
                : languages.MODEL_MANAGER_STATUS_NOT_DOWNLOADED
            }}
          </span>

          <div class="flex w-14 shrink-0 items-center justify-end gap-1">
            <Tooltip v-if="!entry.downloaded && !library.readOnly">
              <TooltipTrigger as-child>
                <button
                  type="button"
                  :aria-label="rowLabel('MODEL_MANAGER_DOWNLOAD_MODEL', entry)"
                  class="flex size-6 items-center justify-center rounded hover:bg-muted"
                  @click="library.downloadOne(entry.id)"
                >
                  <ArrowDownTrayIcon class="size-4 text-muted-foreground" />
                </button>
              </TooltipTrigger>
              <TooltipContent class="bg-card border border-border text-foreground p-2">
                <p class="text-xs">{{ languages.MODEL_MANAGER_ACTION_DOWNLOAD }}</p>
              </TooltipContent>
            </Tooltip>
            <ModelRowActions
              :entry="entry"
              :read-only="library.readOnly"
              @download="library.downloadOne(entry.id)"
              @reveal="library.revealInFolder(entry.id)"
              @edit="emit('edit', entry)"
              @reset-capabilities="library.resetCapabilities(entry.id)"
              @toggle-favorite="library.setFavorite(entry.id, !entry.favorite)"
              @remove-from-list="library.removeFromList(entry.id)"
              @delete="emit('delete', entry)"
            />
          </div>
        </li>
      </ul>
    </TooltipProvider>

    <p
      v-if="library.visibleEntries.length === 0 && !library.scanning"
      class="px-4 py-8 text-center text-sm text-muted-foreground"
    >
      {{ languages.MODEL_MANAGER_NO_RESULTS }}
    </p>
  </div>
</template>
