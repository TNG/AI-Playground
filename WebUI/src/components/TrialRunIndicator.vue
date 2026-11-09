<template>
  <TooltipProvider v-if="runs.length === 1" :delay-duration="200">
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          :class="pillClass"
          :aria-label="openLabel(runs[0].name)"
          @click="open(runs[0].agentId)"
        >
          <span :class="dotClass" />
          <span class="max-w-48 truncate">
            {{ fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_INDICATOR, { name: runs[0].name }) }}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ openLabel(runs[0].name) }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
  <DropdownMenu v-else-if="runs.length > 1">
    <DropdownMenuTrigger as-child>
      <button type="button" :class="pillClass">
        <span :class="dotClass" />
        <span>
          {{ fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_INDICATOR_MANY, { count: runs.length }) }}
        </span>
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent align="end" class="min-w-48">
      <DropdownMenuItem
        v-for="run in runs"
        :key="run.agentId"
        :aria-label="openLabel(run.name)"
        @select="open(run.agentId)"
      >
        {{ run.name }}
      </DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { useUIStore } from '@/assets/js/store/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { fillTemplate } from '@/lib/fillTemplate'

const agentTasks = useAgentTasks()
const uiStore = useUIStore()
const i18n = useI18N().state

const pillClass =
  'inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border border-primary bg-primary/15 text-foreground hover:bg-primary/25 transition-colors'
const dotClass = 'size-1.5 rounded-full bg-primary animate-pulse'

const runs = computed(() =>
  agentTasks.trialRunsInFlight.map((agentId) => {
    const run = agentTasks.trialRuns[agentId]
    const agent = agentTasks.libraryAgents.find((entry) => entry.id === agentId)
    const name =
      (run?.state === 'running' ? run.name : agent?.name.trim()) ||
      i18n.AGENT_LIBRARY_UNNAMED ||
      'Untitled agent'
    return { agentId, name }
  }),
)

function openLabel(name: string): string {
  return fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_INDICATOR_OPEN, { name })
}

function open(agentId: string): void {
  uiStore.openAgentLibrary({ agentId })
}
</script>
