<template>
  <TooltipProvider v-if="runs.length === 1" :delay-duration="200">
    <Tooltip>
      <TooltipTrigger as-child>
        <button
          type="button"
          :class="pillClass"
          :aria-label="openLabel(runs[0])"
          @click="open(runs[0].agentId)"
        >
          <span :class="dotClass(runs[0].waiting)" />
          <span class="max-w-48 truncate">
            {{ fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_INDICATOR, { name: runs[0].name }) }}
          </span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{{ openLabel(runs[0]) }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
  <TooltipProvider v-else-if="runs.length > 1" :delay-duration="200">
    <Tooltip :disabled="!anyWaiting">
      <DropdownMenu>
        <TooltipTrigger as-child>
          <DropdownMenuTrigger as-child>
            <button
              type="button"
              :class="pillClass"
              :aria-label="anyWaiting ? manyLabel : undefined"
            >
              <span :class="dotClass(anyWaiting)" />
              <span>
                {{
                  fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_INDICATOR_MANY, { count: runs.length })
                }}
              </span>
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <DropdownMenuContent align="end" class="min-w-48">
          <DropdownMenuItem
            v-for="run in runs"
            :key="run.agentId"
            :aria-label="openLabel(run)"
            @select="open(run.agentId)"
          >
            <span v-if="run.waiting" :class="dotClass(true)" />
            {{ run.name }}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <TooltipContent side="bottom">{{ manyLabel }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useAgentTrialRuns } from '@/assets/js/store/agentTrialRuns'
import { useI18N } from '@/assets/js/store/i18n'
import { useUIStore } from '@/assets/js/store/ui'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { trialRunDisplayName } from '@/lib/agentNames'
import { fillTemplate } from '@/lib/fillTemplate'

type IndicatedRun = { agentId: string; name: string; waiting: boolean }

const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const agentTrialRuns = useAgentTrialRuns()
const uiStore = useUIStore()
const i18n = useI18N().state

const pillClass =
  'inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border border-primary bg-primary/15 text-foreground hover:bg-primary/25 transition-colors'

function dotClass(waiting: boolean): string {
  return waiting
    ? 'size-1.5 shrink-0 rounded-full bg-amber-500'
    : 'size-1.5 shrink-0 rounded-full bg-primary animate-pulse'
}

const runs = computed<IndicatedRun[]>(() =>
  agentTrialRuns.trialRunsInFlight.map((agentId) => {
    const run = agentTrialRuns.trialRuns[agentId]
    const agent = agentTasks.libraryAgents.find((entry) => entry.id === agentId)
    const name = trialRunDisplayName(run, agent?.name, i18n)
    const waiting = !!run && agentMode.hasHeldPrompt(run.harnessSessionId)
    return { agentId, name, waiting }
  }),
)

const anyWaiting = computed(() => runs.value.some((run) => run.waiting))
const manyLabel = computed(() => i18n.AGENT_LIBRARY_TRIAL_RUN_INDICATOR_MANY_WAITING)

function openLabel(run: IndicatedRun): string {
  if (!run.waiting)
    return fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_INDICATOR_OPEN, { name: run.name })
  const waiting = fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_NEEDS_INPUT, { name: run.name })
  return fillTemplate(i18n.AGENT_LIBRARY_TRIAL_RUN_INDICATOR_WAITING, { waiting })
}

function open(agentId: string): void {
  uiStore.openAgentLibrary({ agentId })
}
</script>
