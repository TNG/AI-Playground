<template>
  <div class="flex flex-col gap-6 p-1">
    <!-- Workspace folder -->
    <div class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">Workspace folder</Label>
      <div class="flex items-center gap-3">
        <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="pickFolder">
          Select folder…
        </Button>
        <span v-if="agentMode.workspaceDir" class="text-sm text-muted-foreground break-all">
          {{ agentMode.workspaceDir }}
        </span>
        <span v-else class="text-sm text-muted-foreground italic">No folder selected</span>
      </div>
      <p class="text-xs text-amber-500">
        The agent runs with all file/shell permissions inside this folder (and its parent directory)
        — proof of concept, use a scratch folder.
      </p>
    </div>

    <!-- Model settings (fully shared with chat via textInference/cloudMode) -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Backend</Label>
      <drop-down-new
        title="Select Backend"
        :value="textInference.backend"
        :items="backendItems"
        @change="handleBackendChange"
      ></drop-down-new>
    </div>
    <!-- Cloud Mode swaps the hardware "Device" picker for a remote "Provider" picker. -->
    <div
      v-if="textInference.backend === 'cloud'"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">Provider</Label>
      <ProviderSelector />
    </div>
    <div v-else class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.DEVICE }}</Label>
      <DeviceSelector :backend="deviceServiceName" />
    </div>
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
      <drop-down-new
        title="Select Model"
        :value="activeModelName"
        :items="modelItems"
        @change="(value: string) => textInference.selectModel(textInference.backend, value)"
      ></drop-down-new>
    </div>
    <div
      v-if="textInference.contextSizeSettingSupported"
      class="grid grid-cols-[120px_1fr] items-center gap-4"
    >
      <Label class="whitespace-nowrap">{{ languages.ANSWER_CONTEXT_SIZE }}</Label>
      <div class="flex items-center gap-3">
        <input
          type="number"
          v-model="textInference.contextSize"
          min="512"
          max="131072"
          step="512"
          class="rounded-sm text-foreground text-center h-7 w-24 leading-7 p-0 bg-transparent border border-border"
        />
        <span v-if="textInference.contextSize < 16384" class="text-xs text-amber-500">
          Agentic sessions typically need 32k+ context.
        </span>
      </div>
    </div>
    <p class="text-xs text-muted-foreground">
      Backend, device/provider, model and context size are shared with Chat mode.
    </p>

    <!-- Tools (built-in media tools + MCP servers) -->
    <div class="border-t border-border pt-4 flex flex-col gap-3">
      <Label class="whitespace-nowrap">Agent tools</Label>
      <p class="text-xs text-muted-foreground">
        The agent always has the AI Playground media tools (image generation and editing). Attach
        MCP servers below to extend it — e.g. Chrome DevTools lets it open a page it built and read
        the browser console/DOM to debug.
      </p>
      <div v-if="mcp.allServers.length > 0" class="flex flex-col gap-2">
        <label
          v-for="server in mcp.allServers"
          :key="server.id"
          class="flex items-start gap-2 text-sm"
        >
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="agentMode.mcpServerIds.includes(server.id)"
            @change="toggleMcpServer(server.id)"
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
      <p class="text-xs text-amber-500">
        Attached MCP servers are started on the next turn (Chrome DevTools launches a browser via
        npx — first run downloads it). Changing this list starts a fresh Pi session.
      </p>
    </div>

    <!-- Session -->
    <div class="border-t border-border pt-4 flex flex-col gap-2">
      <div class="flex items-center gap-2 flex-wrap">
        <Button
          variant="secondary"
          class="px-3 py-1.5 rounded text-sm"
          :disabled="agentMode.processing || agentMode.compacting"
          title="Compact the agent's conversation context (Pi built-in)"
          @click="agentMode.compact()"
        >
          {{ agentMode.compacting ? 'Compacting…' : 'Compact context' }}
        </Button>
        <Button
          variant="secondary"
          class="px-3 py-1.5 rounded text-sm"
          @click="agentMode.newSession()"
        >
          New session
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        Compacting summarizes older conversation context to free up the model's window. New session
        archives the current conversation (find it again under Show Sessions) and starts a fresh Pi
        session.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import DropDownNew from '@/components/DropDownNew.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import {
  backendToService,
  type LlmBackend,
  useTextInference,
  textInferenceBackendDisplayName,
} from '@/assets/js/store/textInference'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useBackendServices } from '@/assets/js/store/backendServices'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useProductMode } from '@/assets/js/store/productMode'
import { useMcp } from '@/assets/js/store/mcp'
import ProviderSelector from '@/components/ProviderSelector.vue'

const agentMode = useAgentMode()
const textInference = useTextInference()
const backendServices = useBackendServices()
const cloudMode = useCloudMode()
const productModeStore = useProductMode()
const mcp = useMcp()

onMounted(() => {
  void mcp.refreshAvailableServers()
})

function toggleMcpServer(serverId: string): void {
  const current = agentMode.mcpServerIds
  agentMode.mcpServerIds = current.includes(serverId)
    ? current.filter((id) => id !== serverId)
    : [...current, serverId]
}

// Non-null service name for the DeviceSelector: only rendered for non-cloud
// backends (cloud shows ProviderSelector instead), so the fallback is inert.
const deviceServiceName = computed(
  () => backendToService[textInference.backend] ?? 'llamacpp-backend',
)

// Mirrors SettingsChat's availableBackends, minus preset gating (agent mode
// has no presets): local backends, filtered by product mode, plus Cloud Mode
// when its feature flag is on.
const availableBackends = computed<LlmBackend[]>(() => {
  let base: LlmBackend[] = ['llamaCPP', 'openVINO']
  if (productModeStore.productMode === 'nvidia') {
    base = base.filter((b) => b !== 'openVINO')
  }
  if (cloudMode.isFeatureEnabled) {
    base = [...base, 'cloud']
  }
  return base
})

const backendItems = computed(() =>
  availableBackends.value.map((backend) => ({
    label: textInferenceBackendDisplayName[backend] ?? backend,
    value: backend,
    active: isBackendRunning(backend),
  })),
)

function isBackendRunning(backend: LlmBackend): boolean {
  // Cloud Mode has no local service — it's "ready" once a provider base URL
  // is configured.
  if (backend === 'cloud') return !!cloudMode.activeProviderBaseUrl
  const serviceName = backendToService[backend]
  return backendServices.info.find((s) => s.serviceName === serviceName)?.status === 'running'
}

function handleBackendChange(newBackend: string) {
  textInference.backend = newBackend as LlmBackend
  // Switching to Cloud Mode refreshes the selected provider's model list
  // (overwriting it on success) so the picker reflects the live provider state.
  if (newBackend === 'cloud') {
    cloudMode.refreshSelectedProviderModels()
  }
}

// Unlike ModelSelector.vue this deliberately skips chat-preset capability
// filtering (and its auto-select watcher): agent mode has no presets, and the
// last active chat preset must not constrain or silently switch the model.
const modelItems = computed(() =>
  textInference.llmModels
    .filter((m) => m.type === textInference.backend)
    .map((m) => ({
      label: m.name.split('/').at(-1) ?? m.name,
      value: m.name,
      active: m.downloaded,
    })),
)

const activeModelName = computed(
  () =>
    textInference.llmModels.filter((m) => m.type === textInference.backend).find((m) => m.active)
      ?.name ?? '',
)

async function pickFolder() {
  await agentMode.pickWorkspaceFolder()
}
</script>
