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
        The agent runs with all file/shell permissions inside this folder (and its parent
        directory) — proof of concept, use a scratch folder.
      </p>
    </div>

    <!-- Model source -->
    <div class="grid grid-cols-[120px_1fr] items-center gap-4">
      <Label class="whitespace-nowrap">Model source</Label>
      <div class="flex rounded-md border border-border overflow-hidden self-start w-fit">
        <button
          class="px-3 py-1.5 text-sm"
          :class="
            agentMode.modelSource === 'local'
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground'
          "
          @click="agentMode.modelSource = 'local'"
        >
          Local model
        </button>
        <button
          class="px-3 py-1.5 text-sm"
          :class="
            agentMode.modelSource === 'cloud'
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground'
          "
          @click="agentMode.modelSource = 'cloud'"
        >
          Cloud model
        </button>
      </div>
    </div>

    <!-- Local model settings (shared with chat via textInference) -->
    <template v-if="agentMode.modelSource === 'local'">
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Backend</Label>
        <drop-down-new
          title="Select Backend"
          :value="textInference.backend"
          :items="backendItems"
          @change="(value: string) => (textInference.backend = value as LlmBackend)"
        ></drop-down-new>
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">{{ languages.DEVICE }}</Label>
        <DeviceSelector :backend="backendToService[textInference.backend]" />
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
        Backend, device, model and context size are shared with Chat mode.
      </p>
    </template>

    <!-- Cloud model settings -->
    <template v-else>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Provider</Label>
        <select
          v-model="agentMode.cloudProvider"
          class="rounded-md border border-border bg-background px-2 py-1.5 text-sm self-start w-fit"
        >
          <option value="ANTHROPIC">Anthropic</option>
          <option value="OPENAI">OpenAI</option>
          <option value="AI_GATEWAY">Vercel AI Gateway</option>
          <option value="OPENROUTER">OpenRouter</option>
        </select>
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">Model id</Label>
        <input
          v-model="agentMode.cloudModel"
          placeholder="e.g. anthropic/claude-sonnet-4.6 (empty = Pi default)"
          class="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
      </div>
      <div class="grid grid-cols-[120px_1fr] items-center gap-4">
        <Label class="whitespace-nowrap">API key</Label>
        <input
          v-model="agentMode.cloudApiKey"
          type="password"
          placeholder="Empty = use host environment variables"
          class="rounded-md border border-border bg-background px-2 py-1.5 text-sm"
        />
      </div>
    </template>

    <!-- Session -->
    <div class="border-t border-border pt-4 flex flex-col gap-2">
      <Button
        variant="secondary"
        class="self-start px-3 py-1.5 rounded text-sm"
        @click="agentMode.resetSession()"
      >
        Reset agent session
      </Button>
      <p class="text-xs text-muted-foreground">
        Clears the conversation and starts a fresh Pi session. Changing the workspace folder or
        model also starts a new session on the next turn.
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
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

const agentMode = useAgentMode()
const textInference = useTextInference()
const backendServices = useBackendServices()

const backendItems = computed(() =>
  (['llamaCPP', 'openVINO'] as LlmBackend[]).map((backend) => ({
    label: textInferenceBackendDisplayName[backend] ?? backend,
    value: backend,
    active:
      backendServices.info.find((s) => s.serviceName === backendToService[backend])?.status ===
      'running',
  })),
)

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
