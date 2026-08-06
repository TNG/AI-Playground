<template>
  <div class="flex flex-col space-y-3 pr-3 h-full overflow-y-auto">
    <div v-if="groups.length === 0" class="px-2 py-4 text-xs text-muted-foreground italic">
      {{ emptyMessage }}
    </div>
    <div v-for="group in groups" :key="group.workspaceDir" class="flex flex-col gap-1">
      <p
        class="px-1 text-xs font-medium text-muted-foreground break-all"
        :title="group.workspaceDir"
      >
        {{ group.workspaceDir }}
      </p>
      <div
        v-for="session in group.sessions"
        :key="session.id"
        class="flex items-center justify-between gap-2 rounded-lg px-3 py-2 transition cursor-pointer border-2"
        :class="
          agentMode.activeSessionId === session.id
            ? 'border-primary bg-muted hover:bg-muted/80'
            : 'border-transparent bg-muted hover:bg-muted/80'
        "
        @click="agentMode.switchSession(session.id)"
      >
        <div class="flex flex-col min-w-0">
          <span class="truncate text-sm text-foreground">{{ session.title }}</span>
          <span class="text-xs text-muted-foreground">{{ relativeTime(session.updatedAt) }}</span>
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
              <AlertDialogAction @click.stop="agentMode.deleteSession(session.id)">
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { Button } from '@/components/ui/button'
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
import { useOemBranding } from '@/assets/js/store/oemBranding'

const agentMode = useAgentMode()
const oemBranding = useOemBranding()

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
      sessions: [...sessions].sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => b.sessions[0].updatedAt - a.sessions[0].updatedAt)
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
