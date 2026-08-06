<script setup lang="ts">
import { computed } from 'vue'
import { MagnifyingGlassIcon } from '@heroicons/vue/24/solid'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import { useI18N } from '@/assets/js/store/i18n'
import { BACKEND_LABELS, type ModelDownloadState } from '@/assets/js/models/library'
import type { CapabilityKey } from '@/assets/js/capabilities'
import type { ModelServiceBackend } from '@/assets/js/models/types'

const emit = defineEmits<{
  (e: 'add-model'): void
  (e: 'delete-selected'): void
  (e: 'edit-folders'): void
}>()

const library = useModelLibrary()
// `languages` is a template-only global, so dropdown items built in script need
// the store directly.
const i18nState = useI18N().state

// The picker's capability row expects a Set, and toggling is additive (AND).
const activeCapabilities = computed(() => new Set(library.filters.capabilities))

function toggleCapability(key: CapabilityKey) {
  const next = new Set(library.filters.capabilities)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  library.setFilters({ capabilities: [...next] })
}

const backendItems = computed(() => [
  { label: i18nState.MODEL_MANAGER_FILTER_ALL_BACKENDS, value: 'all', active: true },
  ...(Object.entries(BACKEND_LABELS) as [ModelServiceBackend, string][]).map(([value, label]) => ({
    label,
    value,
    active: true,
  })),
])

const statusItems = computed(() => [
  { label: i18nState.MODEL_MANAGER_FILTER_ALL_STATUS, value: 'all', active: true },
  { label: i18nState.MODEL_MANAGER_FILTER_ON_DISK, value: 'downloaded', active: true },
  { label: i18nState.MODEL_MANAGER_FILTER_NOT_DOWNLOADED, value: 'notDownloaded', active: true },
])
</script>

<template>
  <div class="flex flex-col gap-3 border-b border-border px-4 py-3">
    <div class="flex flex-wrap items-center gap-3">
      <div
        class="flex min-w-[220px] flex-1 items-center gap-2 rounded-md border border-border bg-background px-2"
      >
        <MagnifyingGlassIcon class="size-4 shrink-0 text-muted-foreground" />
        <input
          type="search"
          :aria-label="languages.MODEL_MANAGER_SEARCH"
          :placeholder="languages.MODEL_MANAGER_SEARCH"
          class="w-full bg-transparent py-1.5 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none"
          :value="library.filters.search"
          @input="library.setFilters({ search: ($event.target as HTMLInputElement).value })"
        />
      </div>
      <CapabilityIcons
        mode="filter"
        :active-keys="activeCapabilities"
        icon-size="size-4"
        @toggle="toggleCapability"
      />
      <div class="w-[150px]">
        <DropDownNew
          :title="languages.MODEL_MANAGER_FILTER_BACKEND"
          :items="backendItems"
          :value="library.filters.backend"
          @change="
            (value: string) => library.setFilters({ backend: value as ModelServiceBackend | 'all' })
          "
        />
      </div>
      <div class="w-[170px]">
        <DropDownNew
          :title="languages.MODEL_MANAGER_FILTER_STATUS"
          :items="statusItems"
          :value="library.filters.downloadState"
          @change="
            (value: string) => library.setFilters({ downloadState: value as ModelDownloadState })
          "
        />
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-4">
      <div class="flex items-center gap-2">
        <Checkbox
          id="model-manager-show-hidden"
          :model-value="library.filters.showHidden"
          @update:model-value="(v) => library.setFilters({ showHidden: v === true })"
        />
        <Label for="model-manager-show-hidden" class="text-sm">
          {{ languages.MODEL_MANAGER_SHOW_HIDDEN }}
        </Label>
      </div>

      <div class="ml-auto flex items-center gap-2">
        <Button
          variant="secondary"
          class="h-8 px-3 text-sm"
          :disabled="library.scanning"
          @click="library.refresh()"
        >
          {{ languages.MODEL_MANAGER_REFRESH }}
        </Button>
        <Button variant="secondary" class="h-8 px-3 text-sm" @click="emit('edit-folders')">
          {{ languages.MODEL_MANAGER_FOLDERS_TITLE }}
        </Button>
        <Button variant="secondary" class="h-8 px-3 text-sm" @click="emit('add-model')">
          {{ languages.COM_ADD + ' ' + languages.MODEL }}
        </Button>
        <!-- Batch actions only appear once something they can act on is picked, so
             the toolbar stays quiet during ordinary browsing. -->
        <Button
          v-if="library.selectedDeletable.length > 0"
          variant="destructive"
          class="h-8 px-3 text-sm"
          @click="emit('delete-selected')"
        >
          {{ languages.MODEL_MANAGER_DELETE_SELECTED }} ({{ library.selectedDeletable.length }})
        </Button>
        <Button
          v-if="library.selectedDownloadable.length > 0"
          class="h-8 px-3 text-sm"
          @click="library.downloadSelected()"
        >
          {{ languages.MODEL_MANAGER_DOWNLOAD_SELECTED }} ({{
            library.selectedDownloadable.length
          }})
        </Button>
      </div>
    </div>
  </div>
</template>
