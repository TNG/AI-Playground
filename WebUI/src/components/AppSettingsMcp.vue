<template>
  <div class="flex flex-col gap-3">
    <SettingsHeading>{{ languages.SETTINGS_MCP_SERVERS }}</SettingsHeading>
    <p class="text-xs text-muted-foreground">{{ languages.SETTINGS_MCP_SERVERS_HINT }}</p>

    <TooltipProvider :delay-duration="200">
      <div class="flex flex-col gap-2">
        <div
          v-for="server in mcp.allServers"
          :key="server.id"
          class="flex items-center justify-between gap-3"
        >
          <div class="flex items-center gap-2 min-w-0">
            <span
              class="w-2.5 h-2.5 rounded-full"
              :class="mcpStatusDotClass(mcp.getServerStatus(server.id).state)"
            />
            <Label class="whitespace-nowrap">{{ server.name }}</Label>
            <Tooltip v-if="server.description">
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[320px] text-sm whitespace-normal">
                {{ server.description }}
              </TooltipContent>
            </Tooltip>
            <span class="text-xs text-muted-foreground">{{
              mcpStatusText(mcp.getServerStatus(server.id).state, languages)
            }}</span>
          </div>

          <div class="flex items-center gap-1">
            <Button
              variant="secondary"
              size="sm"
              class="px-3 py-1.5 rounded text-sm"
              :disabled="mcp.isServerBusy(server.id)"
              @click="mcp.toggleServer(server.id)"
            >
              {{ getStartButtonText(server.id) }}
            </Button>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" class="h-7 w-7">
                  <EllipsisHorizontalIcon class="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem @select="openEditDialog(server.id)">
                  {{ languages.COM_EDIT }}
                </DropdownMenuItem>
                <DropdownMenuItem
                  class="text-destructive focus:text-destructive"
                  @select="handleRemoveServer(server.id)"
                >
                  {{ languages.COM_REMOVE }}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        <div
          v-if="mcp.allServers.length === 0"
          class="text-sm text-muted-foreground text-center py-2"
        >
          {{ languages.SETTINGS_MCP_NO_SERVERS }}
        </div>

        <template v-for="server in mcp.allServers" :key="'error-' + server.id">
          <p v-if="mcp.getServerStatus(server.id).lastError" class="text-xs text-destructive">
            {{ server.name }}: {{ mcp.getServerStatus(server.id).lastError }}
          </p>
        </template>

        <p v-if="mcp.configError" class="text-xs text-destructive">
          {{ mcp.configError }}
        </p>

        <div class="flex flex-wrap justify-start gap-4 pl-2">
          <Button
            variant="link"
            size="sm"
            class="px-0 text-muted-foreground gap-1"
            @click="showAddDialog = true"
          >
            <span class="svg-icon i-add w-4 h-4 shrink-0" />
            {{ languages.SETTINGS_MCP_ADD_SERVER }}
          </Button>
          <Button
            variant="link"
            size="sm"
            class="px-0 text-muted-foreground gap-1"
            @click="openConfig"
          >
            <span class="svg-icon i-pen w-4 h-4 shrink-0" />
            {{ languages.SETTINGS_MCP_EDIT_CONFIG }}
          </Button>
          <Button
            variant="link"
            size="sm"
            class="px-0 text-muted-foreground gap-1"
            @click="openConfigInFolder"
          >
            <span class="svg-icon i-folder w-4 h-4 shrink-0" />
            {{ languages.SETTINGS_MCP_SHOW_IN_FOLDER }}
          </Button>
          <Button
            variant="link"
            size="sm"
            class="px-0 text-muted-foreground gap-1"
            @click="reloadConfig"
          >
            <span class="svg-icon i-refresh w-4 h-4 shrink-0" />
            {{ languages.SETTINGS_MCP_RELOAD }}
          </Button>
        </div>
      </div>

      <McpServerDialog v-model:open="showAddDialog" />
      <McpServerDialog v-model:open="showEditDialog" :edit-server="editServer" />
    </TooltipProvider>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import { useMcp } from '@/assets/js/store/mcp'
import * as toast from '@/assets/js/toast'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import McpServerDialog from '@/components/McpServerDialog.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu'
import { EllipsisHorizontalIcon } from '@heroicons/vue/24/outline'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useErrors } from '@/assets/js/store/errors'
import { mcpStatusDotClass, mcpStatusText } from '@/lib/mcpStatusText'
import type { McpServerConfig } from '@/types/mcpIpc'

const languages = useI18N().state
const mcp = useMcp()
const errors = useErrors()
const showAddDialog = ref(false)
const showEditDialog = ref(false)
const editServer = ref<{ id: string; config: McpServerConfig } | undefined>()

function getStartButtonText(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  return status.state === 'running' || status.state === 'starting'
    ? languages.COM_STOP
    : languages.COM_START
}

onMounted(() => {
  void mcp.refreshAllServerStatuses()
})

function openConfig() {
  window.electronAPI.mcp.openConfig()
}

function openConfigInFolder() {
  window.electronAPI.mcp.openConfigInFolder()
}

async function reloadConfig() {
  await mcp.reloadConfig()
}

async function openEditDialog(serverId: string) {
  try {
    const config = await window.electronAPI.mcp.getServerConfig(serverId)
    editServer.value = { id: serverId, config }
    showEditDialog.value = true
  } catch (error) {
    errors.report(error, {
      category: 'backend',
      code: 'backend/mcp-get-config-failed',
      userMessage:
        error instanceof Error ? error.message : languages.SETTINGS_MCP_GET_CONFIG_FAILED,
    })
  }
}

async function handleRemoveServer(serverId: string) {
  try {
    await window.electronAPI.mcp.removeServer(serverId)
    mcp.forgetServer(serverId)
    toast.success(languages.SETTINGS_MCP_SERVER_REMOVED)
  } catch (error) {
    errors.report(error, {
      category: 'backend',
      code: 'backend/mcp-remove-failed',
      userMessage: error instanceof Error ? error.message : languages.SETTINGS_MCP_REMOVE_FAILED,
    })
  }
}
</script>
