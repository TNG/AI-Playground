<template>
  <TooltipProvider :delay-duration="200">
    <SettingsPanel
      title="MCP tools"
      switch-id="mcp-tools"
      :enabled="textInference.mcpToolsEnabled"
      :disabled-reason="
        textInference.modelSupportsToolCalling
          ? undefined
          : languages.SETTINGS_TOOLS_MODEL_UNSUPPORTED
      "
      @update:enabled="textInference.mcpToolsEnabled = $event"
    >
      <div
        v-show="textInference.modelSupportsToolCalling"
        :class="{ 'opacity-50': !textInference.mcpToolsEnabled }"
        class="flex flex-col gap-2"
      >
        <p class="text-xs text-muted-foreground">{{ languages.SETTINGS_MCP_SESSION_HINT }}</p>

        <label
          v-for="server in mcp.allServers"
          :key="server.id"
          class="flex items-center gap-2 min-w-0 text-sm"
        >
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="textInference.mcpServerIds.includes(server.id)"
            @change="
              textInference.setMcpServerSelected(
                server.id,
                ($event.target as HTMLInputElement).checked,
              )
            "
          />
          <span class="flex min-w-0 flex-col">
            <span class="flex items-center gap-2">
              <span class="whitespace-nowrap">{{ server.name }}</span>
              <Tooltip v-if="server.description">
                <TooltipTrigger as-child>
                  <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
                </TooltipTrigger>
                <TooltipContent side="right" class="max-w-[320px] text-sm whitespace-normal">
                  {{ server.description }}
                </TooltipContent>
              </Tooltip>
              <span class="text-xs text-muted-foreground">{{ getStatusText(server.id) }}</span>
            </span>
            <span v-if="server.instructions" class="text-xs text-muted-foreground">
              {{ server.instructions }}
            </span>
          </span>
        </label>

        <div v-if="mcp.allServers.length === 0" class="text-sm text-muted-foreground py-1">
          {{ languages.SETTINGS_MCP_NO_SERVERS }}
        </div>
      </div>
    </SettingsPanel>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { onMounted } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useMcp } from '@/assets/js/store/mcp'
import { useTextInference } from '@/assets/js/store/textInference'
import SettingsPanel from '@/components/SettingsPanel.vue'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const languages = useI18N().state
const textInference = useTextInference()
const mcp = useMcp()

function getStatusText(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  if (status.state === 'starting') return languages.SETTINGS_MCP_STARTING
  if (status.state === 'running') return languages.SETTINGS_MCP_CONNECTED
  if (status.state === 'error') return languages.SETTINGS_MCP_ERROR_STATE
  return languages.SETTINGS_MCP_DISCONNECTED
}

onMounted(() => {
  void mcp.refreshAvailableServers()
})
</script>
