<script setup lang="ts">
import { Checkbox } from '@/components/ui/checkbox'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StarIcon } from '@heroicons/vue/24/solid'
import { StarIcon as StarOutlineIcon } from '@heroicons/vue/24/outline'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import ModelRowActions from './ModelRowActions.vue'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import {
  BACKEND_LABELS,
  USE_CASE_LABELS,
  formatBytes,
  formatModifiedAt,
  type ModelSortKey,
} from '@/assets/js/models/library'
import type { ModelEntry } from '@/assets/js/models/types'

const emit = defineEmits<{
  (e: 'edit', entry: ModelEntry): void
  (e: 'delete', entry: ModelEntry): void
}>()

const library = useModelLibrary()

const sortableColumns: { key: ModelSortKey; label: string }[] = [
  { key: 'size', label: 'size' },
  { key: 'modified', label: 'modified' },
]

function sortIndicator(key: ModelSortKey): string {
  if (library.sort.key !== key) return ''
  return library.sort.direction === 'asc' ? ' ↑' : ' ↓'
}

/** Everything before the file name, i.e. the repository the model came from. */
function repoOf(entry: ModelEntry): string {
  const segments = entry.name.split('/')
  return segments.length > 1 ? segments.slice(0, -1).join('/') : ''
}

/** A widely-shared model can be required by a dozen presets; the full list is in the title. */
function usedBySummary(entry: ModelEntry): string {
  const [first, second, ...rest] = entry.requiredByPresets
  const shown = [first, second].filter(Boolean).join(', ')
  return rest.length > 0 ? `${shown} +${rest.length}` : shown
}
</script>

<template>
  <div class="min-h-0 flex-1 overflow-auto">
    <Table>
      <TableHeader>
        <TableRow class="hover:bg-transparent">
          <TableHead class="w-8">
            <Checkbox
              :aria-label="languages.MODEL_MANAGER_SELECT_ALL"
              :model-value="library.allVisibleSelected"
              @update:model-value="library.toggleSelectAllVisible()"
            />
          </TableHead>
          <TableHead class="w-8"><span class="sr-only">Favorite</span></TableHead>
          <TableHead>
            <button class="hover:text-foreground" @click="library.toggleSortKey('name')">
              {{ languages.MODEL_MANAGER_COL_MODEL }}{{ sortIndicator('name') }}
            </button>
          </TableHead>
          <TableHead>{{ languages.MODEL_MANAGER_COL_USE_CASE }}</TableHead>
          <TableHead>{{ languages.MODEL_MANAGER_COL_BACKEND }}</TableHead>
          <TableHead v-for="column in sortableColumns" :key="column.key">
            <button class="hover:text-foreground" @click="library.toggleSortKey(column.key)">
              {{
                column.key === 'size'
                  ? languages.MODEL_MANAGER_COL_SIZE
                  : languages.MODEL_MANAGER_COL_MODIFIED
              }}{{ sortIndicator(column.key) }}
            </button>
          </TableHead>
          <TableHead>{{ languages.MODEL_MANAGER_COL_STATUS }}</TableHead>
          <TableHead class="w-10"><span class="sr-only">Actions</span></TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow
          v-for="entry in library.visibleEntries"
          :key="entry.id"
          :class="entry.hidden ? 'opacity-60' : ''"
        >
          <TableCell>
            <Checkbox
              :aria-label="`Select ${entry.label}`"
              :model-value="library.selection.has(entry.id)"
              @update:model-value="library.toggleSelected(entry.id)"
            />
          </TableCell>
          <TableCell>
            <button
              :aria-label="
                entry.favorite
                  ? `${languages.MODEL_MANAGER_ACTION_UNFAVORITE} ${entry.label}`
                  : `${languages.MODEL_MANAGER_ACTION_FAVORITE} ${entry.label}`
              "
              class="flex size-6 items-center justify-center rounded hover:bg-muted"
              @click="library.setFavorite(entry.id, !entry.favorite)"
            >
              <StarIcon v-if="entry.favorite" class="size-4 text-primary" />
              <StarOutlineIcon v-else class="size-4 text-muted-foreground" />
            </button>
          </TableCell>
          <TableCell class="max-w-[340px]">
            <div class="flex items-center gap-2">
              <span class="truncate" :title="entry.name">{{ entry.label }}</span>
              <CapabilityIcons
                v-if="entry.useCase === 'llm'"
                :model="entry.capabilities"
                icon-size="size-3.5"
              />
            </div>
            <!-- The label is only the file name, and different repos ship files
                 with the same name (two `ae.safetensors`), so the repo it came
                 from is what actually tells them apart. -->
            <span v-if="repoOf(entry)" class="block truncate text-xs text-muted-foreground">
              {{ repoOf(entry) }}
            </span>
            <span
              v-if="entry.requiredByPresets.length > 0"
              class="block truncate text-xs text-muted-foreground"
              :title="entry.requiredByPresets.join(', ')"
            >
              {{ languages.MODEL_MANAGER_USED_BY }} {{ usedBySummary(entry) }}
            </span>
          </TableCell>
          <TableCell class="whitespace-nowrap text-muted-foreground">
            {{ USE_CASE_LABELS[entry.useCase] }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-muted-foreground">
            {{ BACKEND_LABELS[entry.serviceBackend] }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-muted-foreground">
            {{ formatBytes(entry.sizeBytes) }}
          </TableCell>
          <TableCell class="whitespace-nowrap text-muted-foreground">
            {{ formatModifiedAt(entry.modifiedAt) }}
          </TableCell>
          <TableCell class="whitespace-nowrap">
            <span class="flex items-center gap-1.5">
              <span
                class="rounded border border-border px-1.5 py-0.5 text-xs"
                :class="entry.downloaded ? 'text-foreground' : 'text-muted-foreground'"
              >
                {{
                  entry.downloaded
                    ? languages.MODEL_MANAGER_STATUS_ON_DISK
                    : languages.MODEL_MANAGER_STATUS_NOT_DOWNLOADED
                }}
              </span>
              <span
                v-if="entry.hidden"
                class="rounded border border-border px-1.5 py-0.5 text-xs text-muted-foreground"
              >
                {{ languages.MODEL_MANAGER_HIDDEN }}
              </span>
            </span>
          </TableCell>
          <TableCell>
            <ModelRowActions
              :entry="entry"
              :read-only="library.readOnly"
              @download="library.downloadOne(entry.id)"
              @reveal="library.revealInFolder(entry.id)"
              @edit="emit('edit', entry)"
              @reset-capabilities="library.resetCapabilities(entry.id)"
              @toggle-hidden="library.setHidden(entry.id, !entry.hidden)"
              @toggle-favorite="library.setFavorite(entry.id, !entry.favorite)"
              @remove-from-list="library.removeFromList(entry.id)"
              @delete="emit('delete', entry)"
            />
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>

    <p
      v-if="library.visibleEntries.length === 0 && !library.scanning"
      class="px-4 py-8 text-center text-sm text-muted-foreground"
    >
      {{ languages.MODEL_MANAGER_NO_RESULTS }}
    </p>
  </div>
</template>
