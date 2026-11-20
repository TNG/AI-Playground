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
            <span class="w-2.5 h-2.5 rounded-full" :class="getStatusDotClass(server.id)" />
            <Label class="whitespace-nowrap">{{ server.name }}</Label>
            <Tooltip v-if="server.description">
              <TooltipTrigger as-child>
                <span class="svg-icon i-info w-4 h-4 shrink-0 opacity-50 cursor-help" />
              </TooltipTrigger>
              <TooltipContent side="right" class="max-w-[320px] text-sm whitespace-normal">
                {{ server.description }}
              </TooltipContent>
            </Tooltip>
            <span class="text-xs text-muted-foreground">{{ getStatusText(server.id) }}</span>
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
import type { McpServerConfig } from '@/types/mcpIpc'

const languages = useI18N().state
const mcp = useMcp()
const showAddDialog = ref(false)
const showEditDialog = ref(false)
const editServer = ref<{ id: string; config: McpServerConfig } | undefined>()

function getStatusText(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  if (status.state === 'starting') return languages.SETTINGS_MCP_STARTING
  if (status.state === 'running') return languages.SETTINGS_MCP_CONNECTED
  if (status.state === 'error') return languages.SETTINGS_MCP_ERROR_STATE
  return languages.SETTINGS_MCP_DISCONNECTED
}

function getStatusDotClass(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  if (status.state === 'stopped') return 'bg-muted-foreground/40'
  if (status.state === 'starting') return 'bg-warning animate-pulse'
  if (status.state === 'running') return 'bg-success'
  if (status.state === 'error') return 'bg-destructive'
  return 'bg-muted-foreground/40'
}

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
    toast.error(error instanceof Error ? error.message : 'Failed to get server config')
  }
}

async function handleRemoveServer(serverId: string) {
  try {
    await window.electronAPI.mcp.removeServer(serverId)
    mcp.forgetServer(serverId)
    toast.success('MCP server removed')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : 'Failed to remove server')
  }
}
</script>
