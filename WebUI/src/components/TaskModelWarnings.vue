<template>
  <Collapsible
    v-if="state.missingCount.value > 0 || downloadError"
    v-model:open="expanded"
    role="group"
    :aria-label="i18n.AGENT_TASK_MODELS_REGION"
    class="flex flex-col gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs"
  >
    <div v-if="state.missingCount.value > 0" class="flex items-center gap-2">
      <ExclamationTriangleIcon class="size-4 shrink-0 text-amber-500" aria-hidden="true" />
      <span class="flex-1 text-foreground">{{ summary }}</span>
      <CollapsibleTrigger
        class="flex items-center gap-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
      >
        {{ expanded ? i18n.AGENT_TASK_MODELS_HIDE_DETAILS : i18n.AGENT_TASK_MODELS_DETAILS }}
        <ChevronDownIcon
          class="size-3.5 transition-transform"
          :class="{ 'rotate-180': expanded }"
          aria-hidden="true"
        />
      </CollapsibleTrigger>
    </div>
    <CollapsibleContent class="pb-1.5">
      <TaskModelWarningList
        :warnings="state.warnings.value"
        :downloading="state.downloading.value"
        actions
        @download="state.download"
      />
    </CollapsibleContent>
    <p v-if="downloadError" role="alert" class="text-destructive">{{ downloadError }}</p>
  </Collapsible>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { ChevronDownIcon, ExclamationTriangleIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import TaskModelWarningList from '@/components/TaskModelWarningList.vue'
import type { TaskModelWarningsState } from '@/assets/js/taskModelWarnings'

const props = defineProps<{ state: TaskModelWarningsState }>()

const i18n = useI18N().state

const expanded = ref(false)

const summary = computed(() =>
  i18n.AGENT_TASK_MODELS_SUMMARY.replace('{count}', String(props.state.missingCount.value)),
)

const downloadError = computed(() => props.state.downloadError.value)
</script>
