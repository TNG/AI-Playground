<template>
  <div class="flex flex-col gap-2 border border-border rounded-md p-3 mr-4">
    <div
      v-for="server in mcp.allServers"
      :key="server.id"
      class="flex items-center justify-between gap-3"
    >
      <div class="flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full" :class="getStatusDotClass(server.id)" />
        <Label class="whitespace-nowrap">{{ server.name }}</Label>
        <span class="text-xs text-muted-foreground">{{ getStatusText(server.id) }}</span>
      </div>

      <Button
        variant="secondary"
        size="sm"
        class="px-3 py-1.5 rounded text-sm"
        :disabled="!textInference.mcpToolsEnabled || mcp.isServerBusy(server.id)"
        @click="mcp.toggleServer(server.id)"
      >
        {{ getStartButtonText(server.id) }}
      </Button>
    </div>

    <div v-if="mcp.allServers.length === 0" class="text-sm text-muted-foreground text-center py-2">
      No MCP servers available
    </div>

    <!-- Red error messages -->

    <template v-for="server in mcp.allServers" :key="'error-' + server.id">
      <p v-if="mcp.getServerStatus(server.id).lastError" class="text-xs text-destructive">
        {{ server.name }}: {{ mcp.getServerStatus(server.id).lastError }}
      </p>
    </template>

    <p v-if="mcp.configError" class="text-xs text-destructive">
      {{ mcp.configError }}
    </p>

    <!-- Footer: config actions -->

    <div class="flex justify-between px-1">
      <div class="flex gap-2">
        <Button
          variant="link"
          size="sm"
          class="px-0 text-muted-foreground"
          @click="showAddDialog = true"
        >
          Add server...
        </Button>
        <Button variant="link" size="sm" class="px-0 text-muted-foreground" @click="openConfig">
          Edit mcp.json
        </Button>
        <Button
          variant="link"
          size="sm"
          class="px-0 text-muted-foreground"
          @click="openConfigInFolder"
        >
          Show in folder
        </Button>
      </div>
      <Button variant="link" size="sm" class="px-0 text-muted-foreground" @click="reloadConfig">
        Reload
      </Button>
    </div>

    <AddMcpServerDialog v-model:open="showAddDialog" />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useMcp } from '@/assets/js/store/mcp'
import { useTextInference } from '@/assets/js/store/textInference'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import AddMcpServerDialog from '@/components/AddMcpServerDialog.vue'

const mcp = useMcp()
const textInference = useTextInference()
const showAddDialog = ref(false)

function getStatusText(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  if (status.state === 'stopped') return 'Disconnected'
  if (status.state === 'starting') return 'Starting...'
  if (status.state === 'running') return 'Connected'
  if (status.state === 'error') return 'Error'
  return 'Disconnected'
}

function getStatusDotClass(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  if (status.state === 'stopped') return 'bg-muted-foreground/40'
  if (status.state === 'starting') return 'bg-amber-500 animate-pulse'
  if (status.state === 'running') return 'bg-green-500'
  if (status.state === 'error') return 'bg-destructive'
  return 'bg-muted-foreground/40'
}

function getStartButtonText(serverId: string): string {
  const status = mcp.getServerStatus(serverId)
  if (status.state === 'stopped') return 'Start'
  if (status.state === 'starting') return 'Stop'
  if (status.state === 'running') return 'Stop'
  if (status.state === 'error') return 'Start'
  return 'Start'
}

onMounted(async () => {
  await mcp.refreshAllServerStatuses()
})

async function openConfig() {
  window.electronAPI.mcp.openConfig()
}

async function openConfigInFolder() {
  window.electronAPI.mcp.openConfigInFolder()
}

async function reloadConfig() {
  await mcp.reloadConfig()
}
</script>
