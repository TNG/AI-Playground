<script setup lang="ts">
import { PlusIcon, Squares2X2Icon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu'
import { useAgentLibraryEntry } from '@/lib/useAgentLibraryEntry'

const i18n = useI18N().state
const { newAgent, manageAgents } = useAgentLibraryEntry()
</script>

<template>
  <DropdownMenuSeparator />
  <DropdownMenuItem class="gap-2" @select="newAgent">
    <PlusIcon class="size-4" />
    {{ i18n.AGENT_LIBRARY_NEW_AGENT }}
  </DropdownMenuItem>
  <DropdownMenuItem class="gap-2" @select="manageAgents()">
    <Squares2X2Icon class="size-4" />
    {{ i18n.AGENT_LIBRARY_MANAGE }}
  </DropdownMenuItem>
</template>
