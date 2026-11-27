<script setup lang="ts">
import { useAgentTasks, type LibraryAgent } from '@/assets/js/store/agentTasks'
import TaskStepsEditor from '@/components/TaskStepsEditor.vue'

defineProps<{ agent: LibraryAgent }>()

const agentTasks = useAgentTasks()
</script>

<template>
  <div class="flex max-w-2xl flex-col gap-2">
    <TaskStepsEditor
      id-prefix="agent-library"
      :steps="agent.steps"
      @update:steps="(steps) => agentTasks.editDraft(agent.id, { steps })"
    />
  </div>
</template>
