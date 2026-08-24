<template>
  <TooltipProvider :delay-duration="200">
    <div class="flex flex-col space-y-3 pr-3 h-full overflow-y-auto">
      <div v-if="groups.length === 0" class="px-2 py-4 text-xs text-muted-foreground italic">
        {{ emptyMessage }}
      </div>
      <div v-for="group in groups" :key="group.workspaceDir" class="flex flex-col gap-1">
        <div
          v-for="row in group.rows"
          :key="row.id"
          class="flex items-center justify-between gap-2 rounded-lg px-3 py-2 transition cursor-pointer border-2"
          :class="
            agentMode.activeSessionId === row.id
              ? 'border-primary bg-muted hover:bg-muted/80'
              : 'border-transparent bg-muted hover:bg-muted/80'
          "
          @click="agentMode.switchSession(row.id)"
        >
          <div class="flex flex-col min-w-0 flex-1">
            <span class="flex items-center gap-1.5 min-w-0">
              <Tooltip>
                <TooltipTrigger as-child>
                  <span class="inline-flex flex-none cursor-help" :aria-label="row.mode">
                    <img
                      v-if="row.presetImage"
                      :src="row.presetImage"
                      :alt="row.mode"
                      class="size-5 rounded object-cover border border-border"
                    />
                    <span
                      v-else
                      class="size-5 rounded border border-border bg-muted grid place-items-center text-[10px] font-medium"
                    >
                      {{ row.mode.slice(0, 1) }}
                    </span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>{{ row.mode }}</TooltipContent>
              </Tooltip>
              <span class="truncate text-sm text-foreground">{{ row.name }}</span>
            </span>
            <div class="flex items-center gap-2 min-w-0">
              <span class="text-xs text-muted-foreground shrink-0">{{
                relativeTime(row.updatedAt)
              }}</span>
              <span class="ml-auto min-w-0 max-w-[60%]">
                <Tooltip>
                  <TooltipTrigger as-child>
                    <span
                      class="inline-flex items-center justify-end gap-1 min-w-0 w-full cursor-help text-xs text-muted-foreground"
                      :aria-label="group.workspaceDir"
                    >
                      <PuzzlePieceIcon v-if="group.path.collapsed" class="size-3.5 flex-none" />
                      <span class="truncate">{{ group.path.rest }}</span>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent class="max-w-xs break-all">{{
                    group.workspaceDir
                  }}</TooltipContent>
                </Tooltip>
              </span>
            </div>
          </div>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                class="h-6 w-6 flex-none"
                title="Delete session"
                @click.stop
              >
                <span class="svg-icon i-clear w-4 h-4"></span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete session?</AlertDialogTitle>
                <AlertDialogDescription>
                  This permanently removes the conversation transcript and the agent's saved session
                  context. Files in the workspace folder are not touched.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel @click.stop>Cancel</AlertDialogCancel>
                <AlertDialogAction @click.stop="agentMode.deleteSession(row.id)">
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>
    </div>
  </TooltipProvider>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { PuzzlePieceIcon } from '@heroicons/vue/24/outline'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { useAgentMode, type AgentSessionRecord } from '@/assets/js/store/agentMode'
import { collapseGamesPrefix, sessionDisplayTitle } from '@/assets/js/store/agentModeSessions'
import { useOemBranding } from '@/assets/js/store/oemBranding'
import { usePresets } from '@/assets/js/store/presets'

const agentMode = useAgentMode()
const oemBranding = useOemBranding()
const presetsStore = usePresets()

function presetImage(presetName?: string): string | undefined {
  if (!presetName) return undefined
  return presetsStore.presets.find((preset) => preset.name === presetName)?.image
}

// A game's display name lives in its `game.json`, not on the session record, so
// that renaming one relabels its sessions too.
const gameNames = ref<Record<string, string>>({})

async function refreshGameNames(): Promise<void> {
  try {
    const games = await window.electronAPI.games.list()
    gameNames.value = Object.fromEntries(games.map((game) => [game.dir, game.name]))
  } catch {
    // Cosmetic: without the library the cards keep their first-prompt titles.
  }
}

onMounted(refreshGameNames)
watch(
  () => [agentMode.presetSessions.length, agentMode.currentGame?.name],
  () => void refreshGameNames(),
)

// The active preset's sessions, grouped by workspace folder; groups and rows
// both ordered by most recent activity.
const groups = computed(() => {
  const byWorkspace = new Map<string, AgentSessionRecord[]>()
  for (const session of agentMode.presetSessions) {
    const list = byWorkspace.get(session.workspaceDir) ?? []
    list.push(session)
    byWorkspace.set(session.workspaceDir, list)
  }
  return [...byWorkspace.entries()]
    .map(([workspaceDir, sessions]) => ({
      workspaceDir,
      path: collapseGamesPrefix(workspaceDir),
      rows: [...sessions]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((session) => ({
          id: session.id,
          updatedAt: session.updatedAt,
          presetImage: presetImage(session.presetName),
          ...sessionDisplayTitle({
            title: session.title,
            presetLabel: session.presetName
              ? oemBranding.presetLabel(session.presetName)
              : undefined,
            gameName: gameNames.value[session.workspaceDir],
          }),
        })),
    }))
    .sort((a, b) => b.rows[0].updatedAt - a.rows[0].updatedAt)
})

// Named after the preset, because the list only holds its sessions — otherwise
// "no sessions yet" reads as a lie next to another preset's history.
const emptyMessage = computed(() => {
  const preset = agentMode.activeAgentPreset?.name
  const label = preset ? oemBranding.presetLabel(preset) : 'Agent'
  return `No ${label} sessions yet. Sessions are archived automatically after each turn.`
})

function relativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}
</script>
