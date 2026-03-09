import { acceptHMRUpdate, defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as toast from '@/assets/js/toast'

type McpConnectionState = 'stopped' | 'starting' | 'running' | 'error'

type McpStatus = {
  state: McpConnectionState
  lastError?: string
}

type McpToolInfo = {
  name: string
  description?: string
}

const BLENDER_SERVER_ID = 'blender'

export const useMcp = defineStore('mcp', () => {
  const blenderStatus = ref<McpStatus>({ state: 'stopped' })
  const blenderTools = ref<McpToolInfo[]>([])

  const blenderConnected = computed(() => blenderStatus.value.state === 'running')
  const blenderBusy = computed(() => blenderStatus.value.state === 'starting')

  async function refreshBlenderStatus() {
    blenderStatus.value = await window.electronAPI.mcp.getServerStatus(BLENDER_SERVER_ID)
    if (blenderStatus.value.state === 'running') {
      blenderTools.value = await window.electronAPI.mcp.listServerTools(BLENDER_SERVER_ID)
    } else {
      blenderTools.value = []
    }
  }

  async function startBlender() {
    const status = await window.electronAPI.mcp.startServer(BLENDER_SERVER_ID)
    blenderStatus.value = status
    if (status.state === 'running') {
      blenderTools.value = await window.electronAPI.mcp.listServerTools(BLENDER_SERVER_ID)
      toast.success('Blender MCP connected')
      return
    }
    toast.error(status.lastError || 'Failed to start Blender MCP')
  }

  async function stopBlender() {
    const status = await window.electronAPI.mcp.stopServer(BLENDER_SERVER_ID)
    blenderStatus.value = status
    blenderTools.value = []
    toast.success('Blender MCP disconnected')
  }

  async function toggleBlender() {
    if (blenderConnected.value) {
      await stopBlender()
      return
    }
    await startBlender()
  }

  return {
    blenderStatus,
    blenderTools,
    blenderConnected,
    blenderBusy,
    refreshBlenderStatus,
    startBlender,
    stopBlender,
    toggleBlender,
  }
})

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useMcp, import.meta.hot))
}
