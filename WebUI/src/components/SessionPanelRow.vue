<template>
  <SessionRow
    :session
    :groups="sessions.groups"
    :active="session.id === sessions.openSessionId"
    :status="lifecycle.rowStatus(session.id)"
    :now
    :time-bucket
    :scheduled="agentTasks.scheduledSessions.get(session.id)"
    :channels-set-up="reachability.channelsSetUp.value"
    :real-shell="reachability.usesRealShell(session.id)"
    :create-group="(name) => sessions.createGroup(session.id, name)"
    @open="lifecycle.openSession(session.id)"
    @open-schedules="ui.openAgentLibrary({ sessionRef: session.id })"
    @rename="(title) => sessions.rename(session.id, title)"
    @pin="(pinned) => sessions.setPinned(session.id, pinned)"
    @move-to-group="(groupId) => sessions.moveToGroup(session.id, groupId)"
    @delete="sessions.remove(session.id)"
    @reachable="(reachable) => reachability.setReachable(session.id, reachable)"
    @set-up-channel="reachability.openChannelSetup()"
  />
</template>

<script setup lang="ts">
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useSessions } from '@/assets/js/store/sessions'
import { useSessionLifecycle } from '@/assets/js/store/sessionLifecycle'
import { useUIStore } from '@/assets/js/store/ui'
import SessionRow from '@/components/SessionRow.vue'
import type { TimeLabelBucket } from '@/lib/sessionTimeLabel'
import { useSessionReachability } from '@/lib/useSessionReachability'
import type { SessionSummary } from '@/types/sessionIpc'

defineProps<{ session: SessionSummary; now: number; timeBucket: TimeLabelBucket }>()

const sessions = useSessions()
const agentTasks = useAgentTasks()
const lifecycle = useSessionLifecycle()
const ui = useUIStore()
const reachability = useSessionReachability()
</script>
