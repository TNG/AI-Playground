<template>
  <McpServerRows :selected="selectedServerIds" :disabled-reason="disabledReason" @toggle="toggle" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { toggleCapabilityIds } from '@/assets/js/store/agentModeSessions'
import McpServerRows from '@/components/McpServerRows.vue'
import { mcpCapabilityId, mcpServerIdOf } from '@/types/agentCapabilities'

defineProps<{
  disabledReason?: string
}>()

const capabilities = defineModel<string[]>({ required: true })

const selectedServerIds = computed(() =>
  capabilities.value.flatMap((id) => {
    const serverId = mcpServerIdOf(id)
    return serverId ? [serverId] : []
  }),
)

function toggle(serverId: string, enabled: boolean): void {
  capabilities.value = toggleCapabilityIds(capabilities.value, mcpCapabilityId(serverId), enabled)
}
</script>
