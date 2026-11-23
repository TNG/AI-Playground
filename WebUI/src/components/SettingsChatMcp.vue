<template>
  <TooltipProvider :delay-duration="200">
    <SettingsPanel
      :title="languages.SETTINGS_MCP_TOOLS"
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
        <McpServerRows
          :selected="textInference.mcpServerIds"
          @toggle="textInference.setMcpServerSelected"
        />
      </div>
    </SettingsPanel>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { useTextInference } from '@/assets/js/store/textInference'
import McpServerRows from '@/components/McpServerRows.vue'
import SettingsPanel from '@/components/SettingsPanel.vue'
import { TooltipProvider } from '@/components/ui/tooltip'

const languages = useI18N().state
const textInference = useTextInference()
</script>
