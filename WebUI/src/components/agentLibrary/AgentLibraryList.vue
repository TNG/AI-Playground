<script setup lang="ts">
import { PlusIcon } from '@heroicons/vue/24/outline'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useI18N } from '@/assets/js/store/i18n'
import { useUIStore } from '@/assets/js/store/ui'
import { Button } from '@/components/ui/button'
import { useAgentLibraryEntry } from '@/lib/useAgentLibraryEntry'

defineProps<{ selectedId?: string }>()

const agentTasks = useAgentTasks()
const i18n = useI18N().state
const ui = useUIStore()
const { newAgent } = useAgentLibraryEntry()
</script>

<template>
  <nav
    class="flex w-64 shrink-0 flex-col gap-3 border-r border-border p-3"
    :aria-label="i18n.AGENT_LIBRARY_LIST"
  >
    <Button variant="secondary" size="sm" class="self-start" @click="newAgent">
      <PlusIcon class="size-4" />
      {{ i18n.AGENT_LIBRARY_NEW_AGENT }}
    </Button>
    <ul class="flex min-h-0 flex-col gap-1 overflow-y-auto">
      <li v-for="agent in agentTasks.libraryAgents" :key="agent.id">
        <button
          type="button"
          class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
          :class="agent.id === selectedId ? 'bg-muted font-medium' : 'text-muted-foreground'"
          :aria-current="agent.id === selectedId ? 'true' : undefined"
          @click="ui.selectLibraryAgent(agent.id)"
        >
          <img
            v-if="agent.image"
            :src="agent.image"
            alt=""
            class="size-6 flex-none rounded object-cover"
          />
          <span v-else class="size-6 flex-none rounded bg-muted" aria-hidden="true" />
          <span class="min-w-0 flex-1 truncate">
            {{ agent.name.trim() || i18n.AGENT_LIBRARY_UNNAMED }}
          </span>
          <span
            v-if="agent.hasDraft"
            class="flex-none rounded bg-amber-600/15 px-1.5 text-[10px] font-medium uppercase text-amber-500"
          >
            {{ i18n.AGENT_LIBRARY_DRAFT }}
          </span>
        </button>
      </li>
    </ul>
  </nav>
</template>
