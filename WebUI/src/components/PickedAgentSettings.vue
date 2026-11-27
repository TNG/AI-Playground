<script setup lang="ts">
import { computed } from 'vue'
import { PencilSquareIcon } from '@heroicons/vue/24/outline'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import SettingsAgentAttributes from '@/components/SettingsAgentAttributes.vue'
import SettingsAgentInferencing from '@/components/SettingsAgentInferencing.vue'
import { useTemplateSettingsBinding } from '@/assets/js/agentTemplateSettings'
import { useAgentLibraryEntry } from '@/lib/useAgentLibraryEntry'
import type { AgentTask } from '@/types/agentTaskIpc'

const props = defineProps<{
  agent: AgentTask
  tab: 'inferencing' | 'attributes'
}>()

const agentTasks = useAgentTasks()
const i18n = useI18N().state
const { manageAgents } = useAgentLibraryEntry()

const { binding } = useTemplateSettingsBinding({
  template: () => props.agent.settingsTemplate,
  problems: () => agentTasks.taskProblems(props.agent.id),
})

const note = computed(() =>
  i18n.AGENT_LIBRARY_PICKED_SETTINGS_NOTE.replace('{agent}', props.agent.name),
)
</script>

<template>
  <div class="flex flex-col w-full">
    <div class="flex items-center justify-end px-4 pt-4 w-full max-w-3xl mx-auto">
      <Button variant="secondary" size="sm" @click="manageAgents(agent.id)">
        <PencilSquareIcon class="size-4" aria-hidden="true" />
        {{ i18n.AGENT_LIBRARY_EDIT_AGENT }}
      </Button>
    </div>
    <SettingsAgentInferencing
      v-if="tab === 'inferencing'"
      :template="binding"
      read-only
      :read-only-note="note"
    />
    <SettingsAgentAttributes v-else :template="binding" read-only :read-only-note="note" />
  </div>
</template>
