<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import ModelLibraryToolbar from '@/components/models/ModelLibraryToolbar.vue'
import ModelLibraryList from '@/components/models/ModelLibraryList.vue'
import EditModelCapabilitiesDialog from '@/components/models/EditModelCapabilitiesDialog.vue'
import DeleteModelDialog from '@/components/models/DeleteModelDialog.vue'
import AddModelDialog from '@/components/models/AddModelDialog.vue'
import { useModelLibrary } from '@/assets/js/store/modelLibrary'
import { useI18N } from '@/assets/js/store/i18n'
import { useCaseLabel as localizedUseCase, type ModelCategory } from '@/assets/js/models/library'
import type { ModelCapabilityValues, ModelEntry } from '@/assets/js/models/types'

const library = useModelLibrary()
const i18n = useI18N()
const i18nState = i18n.state

const editing = ref<ModelEntry | null>(null)
const deleting = ref<ModelEntry[] | null>(null)
const showAddModel = ref(false)

// Favorites sit next to "All" rather than among the use cases: they cut across
// all of them, and they are what a returning user looks for first.
const useCases: ModelCategory[] = ['all', 'favorites', 'llm', 'embedding', 'media', 'speech']

const useCaseLabel = (useCase: ModelCategory) => {
  if (useCase === 'all') return i18nState.MODEL_MANAGER_ALL
  if (useCase === 'favorites') return i18nState.MODEL_MANAGER_FAVORITES
  return localizedUseCase(useCase, { strings: i18nState, tag: i18n.langName })
}

// The dialog is re-created per edit, and its draft is seeded from the entry, so a
// stale row would silently edit the wrong model.
const editingEntry = computed(() =>
  editing.value ? (library.byId(editing.value.id) ?? editing.value) : null,
)

onMounted(() => library.refresh())

async function saveCapabilities(capabilities: Partial<ModelCapabilityValues>) {
  if (!editing.value) return
  await library.saveCapabilities(editing.value.id, capabilities)
  editing.value = null
}

async function resetCapabilities() {
  if (!editing.value) return
  await library.resetCapabilities(editing.value.id)
  editing.value = null
}

async function confirmDelete() {
  const entries = deleting.value
  deleting.value = null
  if (entries) await library.deleteFromDisk(entries.map((entry) => entry.id))
}
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1 flex-col">
    <div class="flex flex-col gap-3 px-6 pt-4 pb-3">
      <nav :aria-label="languages.MODEL_MANAGER_USE_CASE_NAV">
        <ul class="flex flex-wrap gap-1.5">
          <li v-for="useCase in useCases" :key="useCase">
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-full border px-3 py-1 text-sm transition-colors"
              :class="
                library.filters.useCase === useCase
                  ? 'border-primary/50 bg-primary/15 text-foreground font-medium'
                  : 'border-border text-muted-foreground hover:bg-muted hover:text-foreground'
              "
              :aria-current="library.filters.useCase === useCase ? 'true' : undefined"
              @click="library.setFilters({ useCase })"
            >
              <span>{{ useCaseLabel(useCase) }}</span>
              <span class="text-xs text-muted-foreground">
                {{ library.useCaseCounts[useCase] || '–' }}
              </span>
            </button>
          </li>
        </ul>
      </nav>

      <p
        v-if="library.readOnly"
        class="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning"
      >
        {{ languages.MODEL_MANAGER_READ_ONLY }}
      </p>

      <ModelLibraryToolbar
        @add-model="showAddModel = true"
        @delete-selected="deleting = library.selectedDeletable"
      />
    </div>

    <ModelLibraryList
      @edit="(entry) => (editing = entry)"
      @delete="(entry) => (deleting = [entry])"
    />

    <EditModelCapabilitiesDialog
      v-if="editingEntry"
      :entry="editingEntry"
      @cancel="editing = null"
      @save="saveCapabilities"
      @reset="resetCapabilities"
    />

    <DeleteModelDialog
      v-if="deleting && deleting.length > 0"
      :entries="deleting"
      @cancel="deleting = null"
      @confirm="confirmDelete"
    />

    <AddModelDialog
      v-if="showAddModel"
      @close="
        () => {
          showAddModel = false
          library.refresh()
        }
      "
    />
  </div>
</template>
