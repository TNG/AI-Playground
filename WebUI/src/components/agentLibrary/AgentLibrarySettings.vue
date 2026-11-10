<script setup lang="ts">
import { computed } from 'vue'
import { useAgentTasks, type LibraryAgent } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import SettingsAgentAttributes from '@/components/SettingsAgentAttributes.vue'
import SettingsAgentInferencing from '@/components/SettingsAgentInferencing.vue'
import { useTemplateSettingsBinding } from '@/assets/js/agentTemplateSettings'
import { describeSettingsProblems } from '@/lib/sessionSettingsProblems'

const props = defineProps<{ agent: LibraryAgent; part: 'inferencing' | 'attributes' }>()

const agentTasks = useAgentTasks()
const i18n = useI18N().state

const problems = computed(() =>
  props.agent.hasDraft
    ? agentTasks.draftSettingsProblems(props.agent.id)
    : agentTasks.taskProblems(props.agent.id),
)

const { binding } = useTemplateSettingsBinding({
  template: () => props.agent.settingsTemplate,
  problems: () => problems.value,
  edit: (change) => void agentTasks.editDraftSettings(props.agent.id, change),
})

const problemText = computed(() =>
  problems.value.length > 0 ? describeSettingsProblems(problems.value, i18n) : '',
)
</script>

<template>
  <div class="flex max-w-3xl flex-col gap-2">
    <p class="text-xs text-muted-foreground">{{ i18n.AGENT_LIBRARY_SETTINGS_HINT }}</p>
    <p
      v-if="problemText"
      role="status"
      class="text-xs text-amber-500 rounded-sm ring-1 ring-amber-500 px-2 py-1"
    >
      {{ problemText }}
    </p>
    <SettingsAgentInferencing v-if="part === 'inferencing'" :template="binding" />
    <SettingsAgentAttributes v-else :template="binding" />
  </div>
</template>
