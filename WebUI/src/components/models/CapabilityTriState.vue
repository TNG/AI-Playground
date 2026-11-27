<script setup lang="ts">
import { computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'

/**
 * Yes/No/Unset picker for one model capability flag. `undefined` is a real
 * third state — "nobody said", which renders grey with a question-mark badge
 * in the capability rows — not a synonym for "no", so a plain checkbox (whose unchecked arm stores
 * `undefined`) could not express an explicit "no".
 */
const props = defineProps<{
  /** Id of the element that names this group (a `Label` beside it). */
  labelledBy: string
  /** undefined = not specified: inherit the catalog value, or stay unknown. */
  modelValue: boolean | undefined
}>()

const emit = defineEmits<{ (e: 'update:modelValue', value: boolean | undefined): void }>()

const i18nState = useI18N().state

type State = 'unset' | 'yes' | 'no'

const state = computed<State>(() =>
  props.modelValue === undefined ? 'unset' : props.modelValue ? 'yes' : 'no',
)

const items = computed(() => [
  { key: 'unset' as State, label: i18nState.MODEL_MANAGER_CAP_STATE_UNSET, value: undefined },
  { key: 'yes' as State, label: i18nState.MODEL_MANAGER_CAP_STATE_YES, value: true },
  { key: 'no' as State, label: i18nState.MODEL_MANAGER_CAP_STATE_NO, value: false },
])
</script>

<template>
  <div
    role="group"
    :aria-labelledby="labelledBy"
    class="inline-flex shrink-0 items-center overflow-hidden rounded-md border border-border"
  >
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      :aria-pressed="state === item.key"
      class="px-2 py-0.5 text-xs transition-colors"
      :class="
        state === item.key
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted'
      "
      @click="emit('update:modelValue', item.value)"
    >
      {{ item.label }}
    </button>
  </div>
</template>
