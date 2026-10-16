<template>
  <SideModalBase
    id="advanced-settings-sidebar"
    :is-visible="isVisible"
    :title="title"
    hide-header
    side="right"
    @close="$emit('close')"
  >
    <!-- v-if (not v-show): these panels all drive the same (chat-type) active
         preset, and SettingsChat's ModelSelector runs an auto-select watcher that
         force-switches the shared model selection to match the active chat preset's
         filters. Keeping one mounted while another mode is active would silently
         override that mode's selection. -->
    <SettingsChat v-if="props.mode == 'chat'" />
    <SettingsAudio v-else-if="props.mode == 'audio'" />
    <!-- Task mode replaces the session settings rather than rebinding them (ADR 0003). -->
    <SettingsTaskEditor v-else-if="taskMode" />
    <SettingsAgent v-else-if="props.mode == 'agent'" />
    <SettingsWorkflow
      v-show="props.mode == 'imageGen'"
      :categories="['create-images']"
      :title="`${mapModeToLabel(mode)} Presets`"
    />
    <SettingsWorkflow
      v-show="props.mode == 'imageEdit'"
      :categories="['edit-images']"
      :title="`${mapModeToLabel(mode)} Presets`"
    />
    <SettingsWorkflow
      v-show="props.mode == 'video'"
      :categories="['create-videos']"
      :title="`${mapModeToLabel(mode)} Presets`"
    />
  </SideModalBase>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { useModeSettingsLabel } from '@/assets/js/modeSettingsLabel'
import SideModalBase from '@/components/SideModalBase.vue'
import SettingsChat from '@/components/SettingsChat.vue'
import SettingsAgent from '@/components/SettingsAgent.vue'
import SettingsTaskEditor from '@/components/SettingsTaskEditor.vue'
import SettingsAudio from '@/components/SettingsAudio.vue'
import SettingsWorkflow from '@/components/SettingsWorkflow.vue'
import { mapModeToLabel } from '@/lib/utils.ts'

const props = defineProps<{
  mode: ModeType
  isVisible: boolean
}>()

defineEmits<{
  close: []
}>()

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const i18n = useI18N().state
const settingsLabel = useModeSettingsLabel(() => props.mode)

const taskMode = computed(
  () => props.mode === 'agent' && agentMode.sessionScoped && agentTasks.editingTaskId !== null,
)

const title = computed(() =>
  taskMode.value
    ? i18n.AGENT_TASK_EDITING.replace('{name}', agentTasks.editedTask?.name ?? '')
    : settingsLabel.value,
)
</script>
