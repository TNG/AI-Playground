<template>
  <TooltipProvider :delay-duration="200">
    <SettingsTabLayout
      :read-only="locked"
      :read-only-note="readOnlyNote ?? languages.AGENT_TASK_SESSION_SETTINGS_READ_ONLY"
      :template="!!template"
      @reset="template || panel.onPresetReset()"
    >
      <SettingsRow v-if="binding.sections.systemPrompt" align="start">
        <template #label>
          <Label for="agent-system-prompt" class="whitespace-nowrap pt-2">{{
            languages.SETTINGS_SYSTEM_PROMPT
          }}</Label>
        </template>
        <!-- Emptied, the preset's own prompt applies, which the placeholder shows. -->
        <Textarea
          id="agent-system-prompt"
          :model-value="binding.systemPrompt"
          :placeholder="binding.presetSystemPrompt || languages.SETTINGS_SYSTEM_PROMPT_PLACEHOLDER"
          class="min-h-[100px] text-sm"
          @update:model-value="(value) => binding.setSystemPrompt(String(value))"
        />
      </SettingsRow>

      <!-- A Settings Template has no folder of its own: each run gets one. -->
      <section v-if="!template && isManagedWorkspace" class="flex flex-col gap-2">
        <SettingsHeading>{{ languages.AGENT_SETTINGS_GAME_FOLDER }}</SettingsHeading>
        <div class="flex items-center gap-3">
          <Button
            variant="secondary"
            class="px-3 py-1.5 rounded text-sm"
            @click="agentMode.newGame()"
          >
            {{ languages.AGENT_SETTINGS_NEW_GAME }}
          </Button>
          <span v-if="agentMode.workspaceDir" class="text-sm text-muted-foreground break-all">
            {{ agentMode.workspaceDir }}
          </span>
          <span v-else class="text-sm text-muted-foreground italic">
            {{ languages.AGENT_SETTINGS_GAME_FOLDER_PENDING }}
          </span>
        </div>
        <p class="text-xs text-muted-foreground">
          {{ languages.AGENT_SETTINGS_GAME_FOLDER_HINT }}
        </p>
      </section>

      <section v-else-if="!template" class="flex flex-col gap-2">
        <SettingsHeading>{{ languages.AGENT_SETTINGS_WORKSPACE_FOLDER }}</SettingsHeading>
        <span v-if="agentMode.workspaceDir" class="text-sm text-muted-foreground break-all">
          {{ agentMode.workspaceDir }}
        </span>
        <span v-else class="text-sm text-muted-foreground italic">
          {{ languages.AGENT_SETTINGS_WORKSPACE_FOLDER_PENDING }}
        </span>
        <p class="text-xs text-muted-foreground">
          {{ languages.AGENT_SETTINGS_WORKSPACE_FOLDER_HINT }}
        </p>
      </section>

      <!-- Consent is stored per workspace folder, so it only ever affects the folder shown above. -->
      <section v-if="showShellOption" class="flex flex-col gap-2">
        <SettingsHeading>{{ languages.AGENT_SECTION_SHELL }}</SettingsHeading>
        <label class="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            class="mt-0.5"
            :disabled="!agentMode.workspaceDir"
            :checked="agentMode.unsandboxed"
            @change="toggleUnsandboxed"
          />
          <span class="flex flex-col">
            <span class="text-foreground">{{ languages.AGENT_SETTINGS_REAL_SHELL }}</span>
            <span class="text-xs text-muted-foreground">
              {{ languages.AGENT_SETTINGS_REAL_SHELL_HINT }}
            </span>
          </span>
        </label>
        <p v-if="agentMode.unsandboxed" class="text-xs text-amber-500">
          {{
            languages.AGENT_SETTINGS_REAL_SHELL_WARNING.replace('{folder}', agentMode.workspaceDir)
          }}
        </p>
        <p v-else-if="!agentMode.workspaceDir" class="text-xs text-muted-foreground italic">
          {{ languages.AGENT_SETTINGS_REAL_SHELL_NEEDS_FOLDER }}
        </p>
      </section>

      <section v-if="binding.mountedFoldersSupported" class="flex flex-col gap-2">
        <SettingsHeading>{{ languages.AGENT_SETTINGS_MOUNTED_FOLDERS }}</SettingsHeading>
        <p class="text-xs text-muted-foreground">
          {{ languages.AGENT_SETTINGS_MOUNTED_FOLDERS_HINT }}
        </p>
        <MountedFolderList
          :model-value="binding.mountedFolders"
          :session-folder="template ? undefined : agentMode.workspaceDir"
          :real-shell="showShellOption && agentMode.unsandboxed"
          @update:model-value="binding.setMountedFolders"
        />
      </section>

      <section class="flex flex-col gap-3">
        <SettingsHeading>{{ languages.AGENT_SETTINGS_CAPABILITIES }}</SettingsHeading>
        <p class="text-xs text-muted-foreground">
          {{ languages.AGENT_SETTINGS_CAPABILITIES_HINT }}
        </p>
        <AgentCapabilityChecklist
          :model-value="binding.capabilities"
          :catalog="checklist"
          @update:model-value="binding.setCapabilities"
        >
          <template #after="{ id }">
            <!-- The embedding backend, not the chat one: a cloud agent keeps its document search local. -->
            <SettingsRow
              v-if="id === 'rag' && ragEnabled"
              :class="problemClass('embeddingModel')"
              :label="languages.AGENT_SETTINGS_EMBEDDINGS"
            >
              <drop-down-new
                :title="languages.RAG_DOCUMENT_EMBEDDING_MODEL"
                :value="binding.embeddingModelName"
                :items="binding.embeddingModelItems"
                @change="binding.setEmbeddingModel"
              ></drop-down-new>
            </SettingsRow>
          </template>
        </AgentCapabilityChecklist>
        <!-- Sending one as a prompt is exactly how the agent's own input dispatches it. -->
        <div v-if="capabilityCommands.length > 0" class="flex flex-col gap-2">
          <Label class="whitespace-nowrap mt-2">{{
            languages.AGENT_SETTINGS_CAPABILITY_COMMANDS
          }}</Label>
          <div class="flex flex-wrap gap-2">
            <Tooltip v-for="command in capabilityCommands" :key="command.command">
              <TooltipTrigger as-child>
                <Button
                  variant="secondary"
                  class="px-3 py-1.5 rounded text-sm"
                  :disabled="agentMode.processing"
                  @click="agentMode.generate(command.command)"
                >
                  {{ command.command }}
                </Button>
              </TooltipTrigger>
              <TooltipContent class="max-w-xs">{{ command.description }}</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </section>

      <!-- Shown while the capability is unavailable too: this is where its workflows are turned back on. -->
      <section v-if="hasMediaCapability" class="flex flex-col gap-2">
        <SettingsHeading>{{ languages.AGENT_SECTION_MEDIA_TOOLS }}</SettingsHeading>
        <SettingsBuiltinTools
          variant="media"
          bare
          :settings="binding.mediaTools"
          :speak-replies="binding.sections.speakReplies"
        />
      </section>

      <section class="flex flex-col gap-2">
        <SettingsHeading>{{ languages.AGENT_SECTION_MCP_SERVERS }}</SettingsHeading>
        <p
          v-for="serverId in missingMcpServers"
          :key="serverId"
          class="text-xs text-amber-500 rounded-sm ring-1 ring-amber-500 px-2 py-1"
        >
          {{ describeMissingMcpServer(serverId) }}
        </p>
        <AgentMcpServerChecklist
          :model-value="binding.capabilities"
          :servers="mcp.allServers"
          @update:model-value="binding.setCapabilities"
        />
      </section>

      <p v-if="!template" class="text-xs text-amber-500">
        {{ languages.AGENT_SETTINGS_NEXT_TURN }}
      </p>

      <template v-if="!template" #reset-fallback>
        <AgentPresetDefaultsActions @reset="template || panel.refreshCapabilityCatalog()" />
      </template>
    </SettingsTabLayout>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { developerMode } from '@/assets/js/store/debugSettings'
import { useI18N } from '@/assets/js/store/i18n'
import { useMcp } from '@/assets/js/store/mcp'
import AgentCapabilityChecklist from '@/components/AgentCapabilityChecklist.vue'
import AgentMcpServerChecklist from '@/components/AgentMcpServerChecklist.vue'
import AgentPresetDefaultsActions from '@/components/AgentPresetDefaultsActions.vue'
import DropDownNew from '@/components/DropDownNew.vue'
import MountedFolderList from '@/components/MountedFolderList.vue'
import SettingsBuiltinTools from '@/components/SettingsBuiltinTools.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import SettingsRow from '@/components/SettingsRow.vue'
import SettingsTabLayout from '@/components/SettingsTabLayout.vue'
import { useAgentSettingsPanel } from '@/assets/js/agentSettingsPanel'
import type { AgentSettingsBinding } from '@/lib/agentSettingsBinding'
import { checklistCapabilities } from '@/lib/agentSettingsSections'
import { useSettingsProblemMarks } from '@/assets/js/settingsProblemMarks'

const languages = useI18N().state
const agentMode = useAgentMode()
const mcp = useMcp()

const props = defineProps<{
  /** An Agent's Settings Template instead of the open Session's settings. */
  template?: AgentSettingsBinding
  readOnly?: boolean
  readOnlyNote?: string
}>()

const panel = useAgentSettingsPanel()
const binding = computed(() => props.template ?? panel.binding)
const locked = computed(() => (props.template ? props.readOnly : panel.readOnly.value))
const { problemClass, missingMcpServers, describeMissingMcpServer } = useSettingsProblemMarks(
  () => binding.value.problems,
)

// Game folders stay sandboxed: a game is plain HTML with no build step.
const isManagedWorkspace = computed(() => agentMode.agentWorkspaceKind === 'games')
const showShellOption = computed(
  () => !props.template && !isManagedWorkspace.value && developerMode(),
)

function toggleUnsandboxed(event: Event): void {
  agentMode.setUnsandboxed((event.target as HTMLInputElement).checked)
}

const checklist = computed(() =>
  checklistCapabilities(binding.value.capabilityCatalog, binding.value.sections),
)

const hasMediaCapability = computed(() =>
  binding.value.capabilityCatalog.some((capability) => capability.id === 'media'),
)

const ragEnabled = computed(
  () =>
    binding.value.capabilityCatalog.some((capability) => capability.id === 'rag') &&
    binding.value.capabilities.includes('rag'),
)

// An extension that is not part of the session cannot answer its commands.
const capabilityCommands = computed(() =>
  props.template
    ? []
    : binding.value.capabilityCatalog
        .filter((capability) => agentMode.isCapabilityEnabled(capability.id))
        .flatMap((capability) => capability.commands),
)

onMounted(() => {
  void mcp.refreshAvailableServers()
})
</script>
