<template>
  <div class="flex flex-col gap-2 border border-border rounded-md p-3 mr-4">
    <div class="flex items-center justify-between gap-3">
      <div class="flex items-center gap-2">
        <span class="w-2.5 h-2.5 rounded-full" :class="statusDotClass" />
        <Label class="whitespace-nowrap">Blender MCP</Label>
        <span class="text-xs text-muted-foreground">{{ statusText }}</span>
      </div>

      <Button
        variant="secondary"
        size="sm"
        class="px-3 py-1.5 rounded text-sm"
        :disabled="mcp.blenderBusy"
        @click="mcp.toggleBlender"
      >
        {{ startButtonText }}
      </Button>
    </div>

    <p v-if="mcp.blenderStatus.lastError" class="text-xs text-destructive">
      {{ mcp.blenderStatus.lastError }}
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useMcp } from '@/assets/js/store/mcp'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'

const mcp = useMcp()

const statusText = computed(() => {
  if (mcp.blenderStatus.state === 'stopped') return 'Disconnected'
  if (mcp.blenderStatus.state === 'starting') return 'Starting...'
  if (mcp.blenderStatus.state === 'running') return 'Connected'
  if (mcp.blenderStatus.state === 'error') return 'Error'
  return 'Disconnected'
})

const statusDotClass = computed(() => {
  if (mcp.blenderStatus.state === 'stopped') return 'bg-muted-foreground/40'
  if (mcp.blenderStatus.state === 'starting') return 'bg-amber-500 animate-pulse'
  if (mcp.blenderStatus.state === 'running') return 'bg-green-500'
  if (mcp.blenderStatus.state === 'error') return 'bg-destructive'
  return 'bg-muted-foreground/40'
})

const startButtonText = computed(() => {
  if (mcp.blenderStatus.state === 'stopped') return 'Start'
  if (mcp.blenderStatus.state === 'starting') return 'Stop'
  if (mcp.blenderStatus.state === 'running') return 'Stop'
  if (mcp.blenderStatus.state === 'error') return 'Start'
  if (mcp.blenderConnected) return 'Start'
  return 'Start'
})

onMounted(async () => {
  await mcp.refreshBlenderStatus()
})
</script>
