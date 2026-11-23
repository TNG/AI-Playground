<template>
  <div
    v-if="mcp.allServers.length > 0"
    role="group"
    :aria-label="languages.AGENT_SECTION_MCP_SERVERS"
    class="flex flex-col gap-2"
  >
    <p v-if="disabledReason" class="text-xs text-warning">{{ disabledReason }}</p>
    <div
      v-for="server in mcp.allServers"
      :key="server.id"
      class="flex flex-col gap-0.5"
      :class="{ 'opacity-50': disabledReason }"
    >
      <div class="flex items-center justify-between gap-3">
        <div class="flex items-center gap-1.5 min-w-0">
          <Label :for="checkboxId(server.id)" class="truncate">{{ server.name }}</Label>
          <Tooltip v-if="server.description || server.instructions">
            <TooltipTrigger as-child>
              <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
            </TooltipTrigger>
            <TooltipContent side="right" class="max-w-[320px] text-sm whitespace-normal">
              <p v-if="server.description">{{ server.description }}</p>
              <p v-if="server.instructions" class="text-muted-foreground">
                {{ server.instructions }}
              </p>
            </TooltipContent>
          </Tooltip>
          <span
            class="w-2 h-2 shrink-0 rounded-full"
            :class="mcpStatusDotClass(stateOf(server.id))"
          />
          <span class="text-xs text-muted-foreground whitespace-nowrap">
            {{ mcpStatusText(stateOf(server.id), languages, isSelected(server.id)) }}
          </span>
        </div>
        <Checkbox
          :id="checkboxId(server.id)"
          :aria-label="server.name"
          :disabled="!!disabledReason"
          :model-value="isSelected(server.id)"
          @update:model-value="(checked) => emit('toggle', server.id, checked === true)"
        />
      </div>
      <p v-if="mcp.getServerStatus(server.id).lastError" class="text-xs text-destructive">
        {{ mcp.getServerStatus(server.id).lastError }}
      </p>
    </div>
  </div>
  <p v-else class="text-xs text-muted-foreground italic">
    {{ languages.SETTINGS_MCP_NO_SERVERS }} {{ languages.SETTINGS_MCP_CONFIGURE_HINT }}
  </p>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useMcp } from '@/assets/js/store/mcp'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { mcpStatusDotClass, mcpStatusText } from '@/lib/mcpStatusText'
import type { McpConnectionState } from '@/types/mcpIpc'

const props = defineProps<{
  selected: readonly string[]
  /** Set when the model cannot call tools: the servers show but cannot be ticked. */
  disabledReason?: string
}>()

const emit = defineEmits<{
  (e: 'toggle', serverId: string, enabled: boolean): void
}>()

const languages = useI18N().state
const mcp = useMcp()

function isSelected(serverId: string): boolean {
  return props.selected.includes(serverId)
}

function stateOf(serverId: string): McpConnectionState {
  return mcp.getServerStatus(serverId).state
}

function checkboxId(serverId: string): string {
  return `mcp-server-${serverId}`
}

onMounted(() => {
  void mcp.refreshAllServerStatuses()
})
</script>
