<template>
  <div class="flex flex-col gap-2">
    <label
      v-for="capability in builtInCapabilities"
      :key="capability.id"
      class="flex items-start gap-2 text-sm"
    >
      <input
        type="checkbox"
        class="mt-0.5"
        :disabled="!!capability.unavailableReason"
        :checked="isEnabled(capability.id)"
        @change="toggle(capability.id, $event)"
      />
      <span class="flex flex-col">
        <span class="text-foreground">{{ capability.label }}</span>
        <span class="text-xs text-muted-foreground">{{ capability.summary }}</span>
        <span v-if="capability.requires.length > 0" class="text-xs text-muted-foreground">
          Also enables: {{ capabilityLabels(capability.requires) }}
        </span>
        <span v-if="capability.unavailableReason" class="text-xs text-amber-500">
          {{ capability.unavailableReason }}
        </span>
      </span>
    </label>
  </div>

  <!-- What belongs to the enabled built-in capabilities (embeddings, media tools,
       commands) sits between them and the MCP servers. -->
  <slot />

  <Label class="whitespace-nowrap mt-2">MCP servers</Label>
  <slot name="mcp-notices" />
  <div v-if="mcpServers.length > 0" class="flex flex-col gap-2">
    <label v-for="server in mcpServers" :key="server.id" class="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        class="mt-0.5"
        :checked="isEnabled(mcpCapabilityId(server.id))"
        @change="toggle(mcpCapabilityId(server.id), $event)"
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
import { computed } from 'vue'
import { Label } from '@/components/ui/label'
import { toggleCapabilityIds } from '@/assets/js/store/agentModeSessions'
import { MCP_CAPABILITY_PREFIX, mcpCapabilityId } from '@/types/agentCapabilities'

const props = defineProps<{
  catalog: AgentCapabilityInfo[]
  mcpServers: { id: string; name: string; instructions?: string }[]
}>()

const capabilities = defineModel<string[]>({ required: true })

const builtInCapabilities = computed(() =>
  props.catalog.filter((capability) => !capability.id.startsWith(MCP_CAPABILITY_PREFIX)),
)

function isEnabled(id: string): boolean {
  return capabilities.value.includes(id)
}

function toggle(id: string, event: Event): void {
  capabilities.value = toggleCapabilityIds(
    capabilities.value,
    id,
    (event.target as HTMLInputElement).checked,
  )
}

function capabilityLabels(ids: string[]): string {
  return ids.map((id) => props.catalog.find((entry) => entry.id === id)?.label ?? id).join(', ')
}
</script>
