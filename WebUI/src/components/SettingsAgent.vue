<template>
  <div class="flex flex-col gap-6 p-1">
    <div
      v-if="agentMode.sessionScoped && openSessionTask"
      class="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2"
    >
      <span class="text-sm text-muted-foreground min-w-0 break-words">
        {{ i18n.AGENT_TASK_FROM_TASK.replace('{name}', openSessionTask.name) }}
      </span>
      <Button
        variant="link"
        class="h-auto flex-none p-0 text-sm"
        :aria-label="i18n.AGENT_TASKS_EDIT.replace('{name}', openSessionTask.name)"
        @click="editTask(openSessionTask.id)"
      >
        {{ i18n.AGENT_TASK_SESSION_EDIT_TASK }}
      </Button>
    </div>

    <!-- Same picker as Chat Settings: agent presets are chat presets, so this is how
         the user gets back to a plain chat preset (and vice versa). -->
    <PresetSelector
      type="chat"
      :model-value="presetsStore.activePresetName || undefined"
      @update:model-value="handlePresetChange"
    />

    <!-- Managed workspace: the app owns one folder per game, so there is nothing
         to pick — only the game to start over with. -->
    <div v-if="isManagedWorkspace" class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">Game folder</Label>
      <div class="flex items-center gap-3">
        <Button
          variant="secondary"
          class="px-3 py-1.5 rounded text-sm"
          @click="agentMode.newGame()"
        >
          New game
        </Button>
        <span v-if="agentMode.workspaceDir" class="text-sm text-muted-foreground break-all">
          {{ agentMode.workspaceDir }}
        </span>
        <span v-else class="text-sm text-muted-foreground italic">
          Created when you describe your first game
        </span>
      </div>
      <p class="text-xs text-muted-foreground">
        Each game gets its own folder in your game library, and each folder its own session (Show
        Sessions).
      </p>
    </div>

    <!-- Workspace folder -->
    <div v-else class="flex flex-col gap-2">
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
        The agent reads and writes files freely inside this folder — use a scratch folder.
      </p>
    </div>

    <!-- Shell sandbox (per-workspace opt-in) -->
    <div v-if="!isManagedWorkspace" class="flex flex-col gap-2">
      <Label class="whitespace-nowrap">Shell</Label>
      <label class="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          class="mt-0.5"
          :disabled="!agentMode.workspaceDir"
          :checked="agentMode.unsandboxed"
          @change="toggleUnsandboxed"
        />
        <span class="flex flex-col">
          <span class="text-foreground">Use the real system shell in this folder</span>
          <span class="text-xs text-muted-foreground">
            Off by default: the agent gets an emulated shell with no network and no package
            managers, and its file access cannot leave the workspace folder. Turning this on gives
            it a real shell with node, npm, python and live network access, so it can install
            dependencies and run builds.
          </span>
        </span>
      </label>
      <p v-if="agentMode.unsandboxed" class="text-xs text-amber-500">
        Commands run on your machine with your user's permissions and can reach the network. File
        writes are still limited to the workspace, but a command can do anything you could do in a
        terminal. This applies only to {{ agentMode.workspaceDir }} — selecting another folder
        returns to the sandboxed shell.
      </p>
      <p v-else-if="!agentMode.workspaceDir" class="text-xs text-muted-foreground italic">
        Select a workspace folder first.
      </p>
    </div>

    <!-- A fieldset, so every control below (Reka triggers are buttons too) is disabled natively. -->
    <fieldset
      :disabled="settingsReadOnly"
      class="flex flex-col gap-6 min-w-0"
      :aria-describedby="settingsReadOnly ? 'agent-settings-read-only' : undefined"
    >
      <p
        v-if="settingsReadOnly"
        id="agent-settings-read-only"
        class="text-xs text-muted-foreground rounded-sm ring-1 ring-border px-2 py-1"
      >
        {{ i18n.AGENT_TASK_SESSION_SETTINGS_READ_ONLY }}
      </p>

      <!-- Model settings (fully shared with chat via textInference/cloudMode) -->
      <div class="grid grid-cols-[120px_1fr] items-center gap-4" :class="problemClass('backend')">
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
        :class="problemClass('cloudProvider')"
      >
        <Label class="whitespace-nowrap">Provider</Label>
        <ProviderSelector />
      </div>
      <div
        v-else
        class="grid grid-cols-[120px_1fr] items-center gap-4"
        :class="problemClass('device')"
      >
        <Label class="whitespace-nowrap">{{ languages.DEVICE }}</Label>
        <DeviceSelector :backend="deviceServiceName" />
      </div>
      <!-- Named like Chat Settings' model row: the picker's trigger is named after
           whichever model is selected, so the row carries the stable name saying
           what the control is for. -->
      <div
        role="group"
        :aria-label="languages.MODEL"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
        :class="problemClass('model')"
      >
        <Label class="whitespace-nowrap">{{ languages.MODEL }}</Label>
        <!-- Same picker as Chat Settings, so an agent preset's requirements (tool
             calling, and coding for Game Agent) filter the list here too. -->
        <div class="flex items-center gap-2 min-w-0">
          <div class="flex-1 min-w-0">
            <ModelSelector auto-select />
          </div>
          <CapabilityIcons v-if="currentModel" :model="currentModel" />
        </div>
      </div>
      <div
        v-if="textInference.contextSizeSettingSupported"
        class="grid grid-cols-[120px_1fr] items-center gap-4"
      >
        <Label for="agent-context-size" class="whitespace-nowrap">
          {{ languages.ANSWER_CONTEXT_SIZE }}
        </Label>
        <div class="flex items-center gap-3">
          <input
            id="agent-context-size"
            type="text"
            inputmode="numeric"
            autocomplete="off"
            :value="contextSizeField.draft"
            class="rounded-sm text-foreground text-center h-7 w-24 leading-7 p-0 bg-transparent border border-border disabled:opacity-50"
            @focus="contextSizeField.onFocus"
            @input="contextSizeField.onInput"
            @blur="contextSizeField.commit"
            @keydown.enter="contextSizeField.commit"
          />
          <span v-if="textInference.contextSize < 16384" class="text-xs text-amber-500">
            Agentic sessions typically need 32k+ context.
          </span>
        </div>
      </div>
      <p v-if="!agentMode.sessionScoped" class="text-xs text-muted-foreground">
        Backend, device/provider, model and context size are shared with Chat mode.
      </p>

      <!-- Thinking. Only models whose template honours enable_thinking can be told
           to stop, and only a session that thinks has anything to shorten. -->
      <div v-if="textInference.modelSupportsThinkingToggle" class="flex flex-col gap-2">
        <Label class="whitespace-nowrap">Thinking</Label>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            class="mt-0.5"
            :checked="textInference.thinkingEnabled"
            @change="textInference.thinkingEnabled = !textInference.thinkingEnabled"
          />
          <span class="flex flex-col">
            <span class="text-foreground">Think before acting</span>
            <span v-if="!agentMode.sessionScoped" class="text-xs text-muted-foreground">
              Shared with Chat mode, where it applies to every answer.
            </span>
          </span>
        </label>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            class="mt-0.5"
            :disabled="!textInference.thinkingEnabled"
            :checked="agentMode.effectivePlanningThinkingOnly"
            @change="agentMode.setPlanningThinkingOnly(!agentMode.effectivePlanningThinkingOnly)"
          />
          <span class="flex flex-col">
            <span class="text-foreground" :class="{ 'opacity-50': !textInference.thinkingEnabled }">
              Reasoning only during planning
            </span>
            <span class="text-xs text-muted-foreground">
              The agent thinks while it works out what to build and stops once it starts building:
              Game Agent follows the checklist in its plan file from then on, and Quick Coder writes
              its game as a second step, after the plan. Presets that do not plan think throughout.
            </span>
          </span>
        </label>
      </div>
    </fieldset>

    <!-- Between the two fieldsets so a Task Session's read-only rule never disables it. -->
    <SettingsAgentTask v-if="agentMode.sessionScoped" />

    <fieldset
      :disabled="settingsReadOnly"
      class="flex flex-col gap-6 min-w-0"
      :aria-describedby="settingsReadOnly ? 'agent-settings-read-only' : undefined"
    >
      <!-- Capabilities (built-in capability set + MCP servers) -->
      <div class="border-t border-border pt-4 flex flex-col gap-3">
        <Label class="whitespace-nowrap">Capabilities</Label>
        <p class="text-xs text-muted-foreground">
          What the agent is equipped with, on top of its file and shell tools. Each capability adds
          its tools and instructions to the session.
        </p>
        <AgentCapabilityChecklist
          :model-value="agentMode.capabilities"
          :catalog="capabilityCatalog"
          :mcp-servers="mcp.allServers"
          @update:model-value="agentMode.setCapabilities"
        >
          <!-- Same selector as Chat Settings' Embeddings row, but bound to the
               embedding backend rather than the chat backend: an agent can run on a
               cloud model while its document search stays local. The model
               downloads on first actual rag use, not from here. -->
          <div
            v-if="ragEnabled"
            class="grid grid-cols-[120px_1fr] items-center gap-4"
            :class="problemClass('embeddingModel')"
          >
            <Label class="whitespace-nowrap">Embeddings</Label>
            <drop-down-new
              :title="languages.RAG_DOCUMENT_EMBEDDING_MODEL"
              :value="activeEmbeddingModelName"
              :items="embeddingModelItems"
              @change="
                (modelName) =>
                  textInference.selectEmbeddingModel(textInference.embeddingBackend, modelName)
              "
            ></drop-down-new>
          </div>

          <!-- Which workflows the media capability may use. Shown whenever the
               capability exists, including while it reports itself unavailable —
               turning every workflow off is what makes it unavailable, and this is
               where they are turned back on. -->
          <SettingsBuiltinTools v-if="hasMediaCapability" variant="media" />

          <!-- Slash commands of the enabled capabilities: sending one as a prompt is
               exactly how the agent's own input dispatches it. -->
          <div v-if="capabilityCommands.length > 0" class="flex flex-col gap-2">
            <Label class="whitespace-nowrap mt-2">Capability commands</Label>
            <div class="flex flex-wrap gap-2">
              <Button
                v-for="command in capabilityCommands"
                :key="command.command"
                variant="secondary"
                class="px-3 py-1.5 rounded text-sm"
                :disabled="agentMode.processing"
                :title="command.description"
                @click="agentMode.generate(command.command)"
              >
                {{ command.command }}
              </Button>
            </div>
          </div>

          <template #mcp-notices>
            <p
              v-for="serverId in missingMcpServers"
              :key="serverId"
              class="text-xs text-amber-500 rounded-sm ring-1 ring-amber-500 px-2 py-1"
            >
              {{ describeMissingMcpServer(serverId) }}
            </p>
          </template>
        </AgentCapabilityChecklist>
        <p class="text-xs text-amber-500">
          Changes take effect on the next turn, which starts a fresh Pi session. Attached MCP
          servers are started then too.
        </p>
      </div>

      <!-- Same reset affordance the Chat, Audio and workflow panels carry, so every
           preset offers a way back to its defaults. -->
      <div
        v-if="agentMode.sessionScoped"
        class="border-t border-border pt-4 flex flex-wrap items-center gap-2"
      >
        <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="saveAsDefault">
          {{ languages.AGENT_SAVE_AS_DEFAULT }}
        </Button>
        <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="resetToDefault">
          {{ languages.AGENT_RESET_TO_DEFAULT }}
        </Button>
      </div>
      <div v-else class="border-t border-border items-center flex-wrap grid grid-cols-1 gap-2">
        <button class="mt-4" @click="resetPresetSettings">
          <div class="svg-icon i-refresh">Reset</div>
          {{ languages.COM_LOAD_PRESET_DEFAULTS || 'Reset Preset Settings' }}
        </button>
      </div>
    </fieldset>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, toRef } from 'vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import DropDownNew from '@/components/DropDownNew.vue'
import DeviceSelector from '@/components/DeviceSelector.vue'
import ModelSelector from '@/components/ModelSelector.vue'
import CapabilityIcons from '@/components/CapabilityIcons.vue'
import {
  backendToService,
  type LlmBackend,
  useTextInference,
} from '@/assets/js/store/textInference'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { useTaskEditLeaveGuard } from '@/assets/js/taskEditLeaveGuard'
import { useCloudMode } from '@/assets/js/store/cloudMode'
import { useMcp } from '@/assets/js/store/mcp'
import { useCapabilityCatalog } from '@/assets/js/capabilityCatalog'
import { storeMediaToolSettings } from '@/lib/mediaToolSettings'
import { useAgentBackendItems } from '@/assets/js/agentBackendItems'
import { useSettingsProblemMarks } from '@/assets/js/settingsProblemMarks'
import ProviderSelector from '@/components/ProviderSelector.vue'
import PresetSelector from '@/components/PresetSelector.vue'
import SettingsBuiltinTools from '@/components/SettingsBuiltinTools.vue'
import AgentCapabilityChecklist from '@/components/AgentCapabilityChecklist.vue'
import SettingsAgentTask from '@/components/SettingsAgentTask.vue'
import { usePresets } from '@/assets/js/store/presets'
import { usePresetSwitching } from '@/assets/js/store/presetSwitching'
import { useContextSizeField } from '@/assets/js/contextSizeField'
import { useEmbeddingModelPicker } from '@/assets/js/embeddingModelPicker'
import * as toast from '@/assets/js/toast'
import { useI18N } from '@/assets/js/store/i18n'

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const oemBranding = useOemBranding()
const { editTask } = useTaskEditLeaveGuard()
const i18n = useI18N().state

const openSessionTask = computed(() => agentTasks.openSessionTask)
const settingsReadOnly = computed(
  () => agentMode.sessionScoped && agentTasks.openSessionSettingsReadOnly,
)
const presetsStore = usePresets()
const presetSwitching = usePresetSwitching()
const textInference = useTextInference()
const contextSizeField = useContextSizeField(toRef(textInference, 'contextSize'), () =>
  textInference.markContextSizeEdited(),
)
const cloudMode = useCloudMode()
const mcp = useMcp()

// The capability catalog lives in the main process (it is what the Pi session is
// actually built from), so the checkbox list — including which capabilities are
// unavailable and why — is fetched rather than duplicated here.
const mediaTools = storeMediaToolSettings(textInference)
const { catalog: capabilityCatalog, refresh: refreshCapabilityCatalog } = useCapabilityCatalog(
  () => ({
    workspaceDir: agentMode.workspaceDir,
    embeddingModel: textInference.activeEmbeddingModel,
    mediaTools,
  }),
)

const hasMediaCapability = computed(() =>
  capabilityCatalog.value.some((capability) => capability.id === 'media'),
)

// The embedding picker below belongs to the rag capability; hide it with the
// checkbox rather than dangling a control for something the session lacks.
const ragEnabled = computed(
  () =>
    capabilityCatalog.value.some((capability) => capability.id === 'rag') &&
    agentMode.isCapabilityEnabled('rag'),
)

const { activeName: activeEmbeddingModelName, items: embeddingModelItems } =
  useEmbeddingModelPicker(
    () => textInference.llmEmbeddingModels,
    () => textInference.embeddingBackend,
  )

// Only the enabled capabilities' commands: an extension that is not part of the
// session cannot answer them.
const capabilityCommands = computed(() =>
  capabilityCatalog.value
    .filter((capability) => agentMode.isCapabilityEnabled(capability.id))
    .flatMap((capability) => capability.commands),
)

onMounted(async () => {
  void mcp.refreshAvailableServers()
  await refreshCapabilityCatalog()
})

// Game Agent's folders are the app's to create, and they stay sandboxed: a game is
// plain HTML with no build step, so a real shell would only add risk.
const isManagedWorkspace = computed(() => agentMode.agentWorkspaceKind === 'games')

// Consent is stored per workspace folder, so this only ever affects the folder
// currently selected — pointing the agent elsewhere needs a fresh opt-in.
function toggleUnsandboxed(event: Event): void {
  agentMode.setUnsandboxed((event.target as HTMLInputElement).checked)
}

// Non-null service name for the DeviceSelector: only rendered for non-cloud
// backends (cloud shows ProviderSelector instead), so the fallback is inert.
const deviceServiceName = computed(
  () => backendToService[textInference.backend] ?? 'llamacpp-backend',
)

const { items: backendItems } = useAgentBackendItems(() => agentMode.activeAgentPreset?.backends)

function handleBackendChange(newBackend: string) {
  textInference.backend = newBackend as LlmBackend
  // Switching to Cloud Mode refreshes the selected provider's model list
  // (overwriting it on success) so the picker reflects the live provider state.
  if (newBackend === 'cloud') {
    cloudMode.refreshSelectedProviderModels()
  }
}

// Active model (capabilities) for the icon row next to the selector — same source
// as SettingsChat / PromptStatusBar.
const currentModel = computed(() =>
  textInference.llmModels.find((m) => m.active && m.type === textInference.backend),
)

async function pickFolder() {
  await agentMode.pickWorkspaceFolder()
}

/**
 * Back to the active agent preset's defaults: the shared model settings via
 * textInference (as in Chat Settings), plus the agent-only ones this panel adds.
 * The workspace folder, its sandbox consent and the sessions are user-owned
 * state, not preset settings, so they survive.
 */
function resetPresetSettings() {
  textInference.resetActivePresetSettings()
  agentMode.resetPresetSettings()
  void refreshCapabilityCatalog()
  toast.success('Reset to preset defaults')
}

const { problemClass, missingMcpServers, describeMissingMcpServer } = useSettingsProblemMarks(
  () => agentMode.settingsProblems,
)

function saveAsDefault() {
  agentMode.saveAsDefault()
  toast.success(i18n.AGENT_SAVED_AS_DEFAULT)
}

function resetToDefault() {
  agentMode.resetToDefault()
  void refreshCapabilityCatalog()
  toast.success(i18n.AGENT_RESET_TO_DEFAULT_DONE)
}

async function handlePresetChange(presetName: string) {
  const result = await presetSwitching.switchPreset(presetName)
  if (result.success) {
    toast.success(`Switched to ${oemBranding.presetLabel(presetName)}`)
  } else if (result.error) {
    toast.error(`Failed to switch preset: ${result.error}`)
  }
}
</script>
