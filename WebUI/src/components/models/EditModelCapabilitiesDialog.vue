<script setup lang="ts">
import { ref, watch } from 'vue'
import ModelCapabilityFields from './ModelCapabilityFields.vue'
import { pickDefined } from '@/assets/js/models/overrides'
import type { ModelCapabilityValues, ModelEntry } from '@/assets/js/models/types'

const props = defineProps<{ entry: ModelEntry }>()

const emit = defineEmits<{
  (e: 'cancel'): void
  (e: 'save', capabilities: Partial<ModelCapabilityValues>): void
  (e: 'reset'): void
}>()

const draft = ref<ModelCapabilityValues>({ ...props.entry.capabilities })

watch(
  () => props.entry.id,
  () => {
    draft.value = { ...props.entry.capabilities }
  },
)
</script>

<template>
  <div class="dialog-container z-20">
    <div
      class="dialog-mask absolute left-0 top-0 flex h-full w-full items-center justify-center bg-background/70"
    >
      <div
        role="dialog"
        :aria-label="languages.MODEL_MANAGER_EDIT_TITLE"
        class="flex max-h-[85vh] w-[520px] flex-col gap-4 overflow-y-auto rounded-2xl bg-card p-8 text-foreground shadow-2xl"
      >
        <div class="flex flex-col gap-1">
          <h2 class="text-lg font-semibold">{{ languages.MODEL_MANAGER_EDIT_TITLE }}</h2>
          <p class="text-xs break-all text-muted-foreground">{{ entry.name }}</p>
        </div>

        <p class="text-sm text-muted-foreground">{{ languages.MODEL_MANAGER_EDIT_DESCRIPTION }}</p>

        <ModelCapabilityFields
          v-model="draft"
          :service-backend="entry.serviceBackend"
          show-advanced
          id-prefix="edit-capability"
        />

        <div class="flex items-center justify-between gap-3">
          <button
            v-if="entry.hasCapabilityOverrides"
            class="rounded bg-muted px-4 py-1.5 text-sm"
            @click="emit('reset')"
          >
            {{ languages.MODEL_MANAGER_EDIT_RESET }}
          </button>
          <span v-else class="text-xs text-muted-foreground">
            {{ languages.MODEL_MANAGER_EDIT_NO_OVERRIDES }}
          </span>
          <div class="flex gap-3">
            <button class="rounded bg-muted px-4 py-1.5 text-sm" @click="emit('cancel')">
              {{ languages.COM_CANCEL }}
            </button>
            <button
              class="rounded bg-primary px-4 py-1.5 text-sm text-primary-foreground"
              @click="emit('save', pickDefined(draft))"
            >
              {{ languages.MODEL_MANAGER_SAVE }}
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
