<script setup lang="ts">
// Where each kind of model is stored on disk. The store and IPC for this have
// existed unused since before the model library; this is the UI for them.
import { computed, ref, watch } from 'vue'
import FolderSelector from '@/components/FolderSelector.vue'
import { useModels } from '@/assets/js/store/models'
import { useI18N } from '@/assets/js/store/i18n'
import { useErrors } from '@/assets/js/store/errors'
import { MODEL_SCAN_TARGETS, type ModelUseCase } from '@/assets/js/models/types'
import { USE_CASE_LABELS } from '@/assets/js/models/library'

const emit = defineEmits<{ (e: 'close'): void; (e: 'saved'): void }>()

const models = useModels()
const i18nState = useI18N().state
const errors = useErrors()

const draft = ref<Record<string, string>>({ ...models.paths })
const saving = ref(false)

watch(
  () => models.paths,
  (paths) => {
    draft.value = { ...paths }
  },
  { deep: true },
)

/**
 * One row per configured directory, grouped by what lives in it. Path keys the
 * user's config does not define are skipped rather than invented, and the
 * `lora`/`loras` style aliases collapse because the scan targets are already
 * deduplicated by directory.
 */
const groups = computed(() => {
  const seen = new Set<string>()
  const byUseCase = new Map<ModelUseCase, { pathKey: string; value: string }[]>()
  for (const target of MODEL_SCAN_TARGETS) {
    if (seen.has(target.pathKey)) continue
    seen.add(target.pathKey)
    const value = draft.value[target.pathKey]
    if (value === undefined) continue
    const rows = byUseCase.get(target.useCase) ?? []
    rows.push({ pathKey: target.pathKey, value })
    byUseCase.set(target.useCase, rows)
  }
  return [...byUseCase.entries()].map(([useCase, rows]) => ({
    useCase,
    label: USE_CASE_LABELS[useCase],
    rows,
  }))
})

const changedKeys = computed(() =>
  Object.keys(draft.value).filter((key) => draft.value[key] !== models.paths[key]),
)

function setPath(pathKey: string, value: string) {
  draft.value = { ...draft.value, [pathKey]: value }
}

async function save() {
  saving.value = true
  try {
    await models.applyPathsSettings({ ...models.paths, ...draft.value })
    emit('saved')
    emit('close')
  } catch (error) {
    errors.report(error, {
      category: 'model',
      code: 'model/paths-update-failed',
      userMessage: 'Could not update the model folders.',
    })
  } finally {
    saving.value = false
  }
}

async function restoreDefaults() {
  saving.value = true
  try {
    await models.restorePathsSettings()
    draft.value = { ...models.paths }
    emit('saved')
  } catch (error) {
    errors.report(error, {
      category: 'model',
      code: 'model/paths-restore-failed',
      userMessage: 'Could not restore the default model folders.',
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="dialog-container z-20">
    <div
      class="dialog-mask absolute left-0 top-0 flex h-full w-full items-center justify-center bg-background/70"
    >
      <div
        role="dialog"
        :aria-label="i18nState.MODEL_MANAGER_FOLDERS_TITLE"
        class="flex max-h-[85vh] w-[720px] flex-col gap-4 rounded-2xl bg-card p-8 text-foreground shadow-2xl"
      >
        <div class="flex flex-col gap-1">
          <h2 class="text-lg font-semibold">{{ languages.MODEL_MANAGER_FOLDERS_TITLE }}</h2>
          <p class="text-sm text-muted-foreground">
            {{ languages.MODEL_MANAGER_FOLDERS_DESCRIPTION }}
          </p>
        </div>

        <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto pr-1">
          <section v-for="group in groups" :key="group.useCase" class="flex flex-col gap-2">
            <h3 class="text-sm font-medium text-muted-foreground">{{ group.label }}</h3>
            <div
              v-for="row in group.rows"
              :key="row.pathKey"
              class="grid grid-cols-[160px_1fr] items-center gap-3"
            >
              <span class="truncate text-sm">{{ row.pathKey }}</span>
              <FolderSelector
                :folder="row.value"
                :label="row.pathKey"
                @update:folder="(value: string) => setPath(row.pathKey, value)"
              />
            </div>
          </section>
        </div>

        <p v-if="changedKeys.length > 0" class="text-xs text-muted-foreground">
          {{ languages.MODEL_MANAGER_FOLDERS_MOVE_HINT }}
        </p>

        <div class="flex items-center justify-between gap-3">
          <button
            class="rounded bg-muted px-4 py-1.5 text-sm"
            :disabled="saving"
            @click="restoreDefaults"
          >
            {{ languages.MODEL_MANAGER_FOLDERS_RESTORE }}
          </button>
          <div class="flex gap-3">
            <button class="rounded bg-muted px-4 py-1.5 text-sm" @click="emit('close')">
              {{ languages.COM_CANCEL }}
            </button>
            <button
              class="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
              :disabled="saving || changedKeys.length === 0"
              @click="save"
            >
              {{ languages.MODEL_MANAGER_SAVE }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
