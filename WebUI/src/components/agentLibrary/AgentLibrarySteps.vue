<script setup lang="ts">
import { useAgentTasks, type LibraryAgent } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import TaskStepsEditor from '@/components/TaskStepsEditor.vue'

defineProps<{ agent: LibraryAgent }>()

const agentTasks = useAgentTasks()
const i18n = useI18N().state
</script>

<template>
  <section class="flex max-w-2xl flex-col gap-2" aria-labelledby="agent-library-steps-heading">
    <h2 id="agent-library-steps-heading" class="text-sm font-semibold">
      {{ i18n.AGENT_LIBRARY_STEPS }}
    </h2>
    <TaskStepsEditor
      id-prefix="agent-library"
      :steps="agent.steps"
      @update:steps="(steps) => agentTasks.editDraft(agent.id, { steps })"
    />
  </section>
</template>
