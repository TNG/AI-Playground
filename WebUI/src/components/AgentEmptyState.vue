<template>
  <!-- Configuration lives in the settings tabs, model/context in the prompt
       status bar — so an empty transcript just needs a hint. -->
  <div class="flex flex-col items-center gap-3 py-16 text-center text-muted-foreground">
    <img src="../assets/svg/ai-icon.svg" class="size-10 opacity-60" />
    <template v-if="emptyStateKind === 'game-agent'">
      <p class="text-sm">
        Describe the game you want — the agent writes it as a single HTML page, draws the art,
        play-tests it in a browser and saves it to your library.
      </p>
      <p class="text-xs">Try: “a one-button endless runner where I dodge asteroids”.</p>
    </template>
    <template v-else-if="emptyStateKind === 'quick-coder'">
      <p class="text-sm">
        Describe the game you want — the agent plans it, then writes the whole thing into one HTML
        file. No generated art and no play-testing, so it finishes in minutes.
      </p>
      <p class="text-xs">Try: “a one-button endless runner where I dodge asteroids”.</p>
    </template>
    <template v-else>
      <p class="text-sm">{{ languages.AGENT_EMPTY_STATE_ASSISTANT }}</p>
      <p v-if="showsWorkspace" class="text-xs break-all">
        {{ fillTemplate(languages.AGENT_EMPTY_STATE_WORKSPACE, { path: agentMode.workspaceDir }) }}
      </p>
      <p class="text-xs">{{ languages.AGENT_EMPTY_STATE_CONFIGURE }}</p>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { agentEmptyStateKind } from '@/lib/presetModes'
import { fillTemplate } from '@/lib/fillTemplate'
import { FILES_CAPABILITY_ID } from '@/types/agentCapabilities'

const agentMode = useAgentMode()
const emptyStateKind = computed(() => agentEmptyStateKind(agentMode.activeAgentPreset?.name))
const showsWorkspace = computed(
  () => !!agentMode.workspaceDir && agentMode.isCapabilityEnabled(FILES_CAPABILITY_ID),
)
</script>
