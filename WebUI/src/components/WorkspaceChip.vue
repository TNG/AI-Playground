<template>
  <TooltipProvider v-if="chip" :delay-duration="200">
    <DropdownMenu v-if="chip.folders.length > 1 || missing">
      <DropdownMenuTrigger as-child>
        <button
          type="button"
          :class="[chipClass, missing ? 'text-warning' : 'text-muted-foreground']"
          :aria-label="label"
        >
          <ExclamationTriangleIcon v-if="missing" class="size-4 flex-none" aria-hidden="true" />
          <FolderOpenIcon v-else class="size-4 flex-none" aria-hidden="true" />
          <span class="truncate">{{ chip.name }}</span>
          <ChevronDownIcon class="size-3 flex-none" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent side="top" align="start" class="z-[40010] min-w-48 max-w-96">
        <DropdownMenuLabel class="text-xs">{{ languages.SESSION_FOLDERS }}</DropdownMenuLabel>
        <Tooltip v-for="folder in chip.folders" :key="folder.id">
          <TooltipTrigger as-child>
            <!-- A missing folder stays focusable rather than `disabled`, so its path still shows. -->
            <DropdownMenuItem
              class="gap-2"
              :aria-label="languages.SESSION_FOLDER_OPEN_NAMED.replace('{folder}', folder.name)"
              :aria-disabled="isMissing(folder) || undefined"
              :class="{ 'opacity-50': isMissing(folder) }"
              @select="(event: Event) => openFolder(folder, event)"
            >
              <ExclamationTriangleIcon
                v-if="isMissing(folder)"
                class="size-4 flex-none text-warning"
                aria-hidden="true"
              />
              <StarIcon
                v-else-if="folder.workspace"
                class="size-4 flex-none text-primary"
                aria-hidden="true"
              />
              <FolderIcon v-else class="size-4 flex-none" aria-hidden="true" />
              <span class="truncate">{{ folder.name }}</span>
              <span v-if="folder.workspace" class="ml-auto pl-2 text-xs text-muted-foreground">
                {{ languages.SESSION_FOLDER_WORKSPACE }}
              </span>
              <LockClosedIcon
                v-else-if="folder.agentId"
                class="ml-auto size-3.5 flex-none text-muted-foreground"
                aria-hidden="true"
              />
            </DropdownMenuItem>
          </TooltipTrigger>
          <TooltipContent side="right" class="z-[40011] max-w-96 break-all">
            {{ folder.path }}
            <span v-if="folder.agentId && agent" class="block text-muted-foreground">
              {{ languages.SESSION_FOLDER_SET_BY_AGENT.replace('{agent}', agent.name) }}
            </span>
          </TooltipContent>
        </Tooltip>
        <template v-if="agent && chip.folders.some((folder) => folder.agentId)">
          <DropdownMenuSeparator />
          <DropdownMenuItem class="gap-2" @select="manageAgents(agent.id)">
            <PencilSquareIcon class="size-4 flex-none" aria-hidden="true" />
            <span class="truncate">{{ languages.AGENT_LIBRARY_EDIT_AGENT }}</span>
          </DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenu>
    <Tooltip v-else>
      <TooltipTrigger as-child>
        <button
          type="button"
          :class="[chipClass, 'text-muted-foreground']"
          :aria-label="label"
          @click="openFolder(chip.folders[0])"
        >
          <FolderOpenIcon class="size-4 flex-none" aria-hidden="true" />
          <span class="truncate">{{ chip.name }}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" class="max-w-96 break-all">{{ chip.path }}</TooltipContent>
    </Tooltip>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  ChevronDownIcon,
  ExclamationTriangleIcon,
  FolderIcon,
  FolderOpenIcon,
  LockClosedIcon,
  PencilSquareIcon,
} from '@heroicons/vue/24/outline'
import { StarIcon } from '@heroicons/vue/24/solid'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { usePromptStore } from '@/assets/js/store/promptArea'
import { useSessions } from '@/assets/js/store/sessions'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useAgentLibraryEntry } from '@/lib/useAgentLibraryEntry'
import { workspaceChipOf, type WorkspaceChipFolder } from '@/lib/workspaceChip'

const languages = useI18N().state
const sessions = useSessions()
const agentMode = useAgentMode()
const agentTasks = useAgentTasks()
const demoMode = useDemoMode()
const errors = useErrors()
const promptStore = usePromptStore()
const { manageAgents } = useAgentLibraryEntry()

const chipClass =
  'flex min-w-0 max-w-56 items-center gap-1 p-1 hover:text-foreground transition-colors'

// A demo run ignores an Agent's folder overrides, so the chip shows the Session's folders.
const agent = computed(() => {
  const picked = agentTasks.activeAgent
  if (!picked) return undefined
  const overrides = demoMode.enabled ? undefined : picked.settingsTemplate.folderOverrides
  return { id: picked.id, name: picked.name, overrides }
})

const chip = computed(() =>
  workspaceChipOf({
    games: promptStore.getCurrentMode() === 'agent' && agentMode.agentWorkspaceKind === 'games',
    folderList: sessions.openSession?.folderList,
    agent: agent.value,
  }),
)

// The Workspace in effect: the Agent's own folder while it sets one, else the Session's.
const missing = computed(() => {
  const agentId = chip.value?.folders[0]?.agentId
  if (!chip.value) return false
  return agentId ? !!agentTasks.missingAgentWorkspaces[agentId] : !!sessions.openMissingWorkspace
})

const label = computed(() =>
  (missing.value
    ? languages.SESSION_WORKSPACE_CHIP_MISSING
    : languages.SESSION_WORKSPACE_CHIP
  ).replace('{folder}', chip.value?.name ?? ''),
)

function isMissing(folder: WorkspaceChipFolder): boolean {
  return folder.workspace && missing.value
}

async function openFolder(folder: WorkspaceChipFolder | undefined, event?: Event): Promise<void> {
  const id = sessions.openSession?.id
  if (!folder || !id) return
  if (isMissing(folder)) {
    event?.preventDefault()
    return
  }
  if (folder.agentId) {
    await openAgentFolder(folder.agentId, folder.path)
    return
  }
  await sessions.openFolder(id, folder.id)
}

async function openAgentFolder(agentId: string, hostPath: string): Promise<void> {
  const result = await window.electronAPI.agentMode.openTaskFolder(agentId, hostPath)
  if (!result.success) {
    errors.report(new Error(result.error), {
      code: 'session-folders/open-agent-folder-failed',
      category: 'backend',
      surface: 'inline',
    })
  }
}
</script>
