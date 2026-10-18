<template>
  <div v-if="servers.length > 0" class="flex flex-col gap-2">
    <label v-for="server in servers" :key="server.id" class="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        class="mt-0.5"
        :checked="isEnabled(server.id)"
        @change="toggle(server.id, $event)"
      />
      <span class="flex flex-col">
        <span class="text-foreground">{{ server.name }}</span>
        <span v-if="server.instructions" class="text-xs text-muted-foreground">
          {{ server.instructions }}
        </span>
      </span>
    </label>
  </div>
  <p v-else class="text-xs text-muted-foreground italic">
    No MCP servers configured. Add one under App Settings → MCP.
  </p>
</template>

<script setup lang="ts">
import { toggleCapabilityIds } from '@/assets/js/store/agentModeSessions'
import { mcpCapabilityId } from '@/types/agentCapabilities'

defineProps<{
  servers: { id: string; name: string; instructions?: string }[]
}>()

const capabilities = defineModel<string[]>({ required: true })

function isEnabled(serverId: string): boolean {
  return capabilities.value.includes(mcpCapabilityId(serverId))
}

function toggle(serverId: string, event: Event): void {
  capabilities.value = toggleCapabilityIds(
    capabilities.value,
    mcpCapabilityId(serverId),
    (event.target as HTMLInputElement).checked,
  )
}
</script>
