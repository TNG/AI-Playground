<script setup lang="ts">
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { EllipsisHorizontalIcon } from '@heroicons/vue/24/solid'
import type { ModelEntry } from '@/assets/js/models/types'

const props = defineProps<{
  entry: ModelEntry
  /** Destructive actions are unavailable on a read-only model folder. */
  readOnly: boolean
}>()

const emit = defineEmits<{
  (e: 'download'): void
  (e: 'reveal'): void
  (e: 'edit'): void
  (e: 'reset-capabilities'): void
  (e: 'toggle-hidden'): void
  (e: 'toggle-favorite'): void
  (e: 'remove-from-list'): void
  (e: 'delete'): void
}>()

// Capabilities only mean anything for chat models; a checkpoint has none.
const canEditCapabilities = computed(() => props.entry.useCase === 'llm')
const canDelete = computed(
  () => props.entry.downloaded && !!props.entry.absolutePath && !props.readOnly,
)
</script>

<template>
  <DropdownMenu>
    <DropdownMenuTrigger as-child>
      <button
        class="flex size-6 items-center justify-center rounded hover:bg-muted"
        :aria-label="`${entry.label} actions`"
      >
        <EllipsisHorizontalIcon class="size-4 text-muted-foreground" />
      </button>
    </DropdownMenuTrigger>
    <DropdownMenuContent
      align="end"
      class="min-w-[220px] rounded-md border border-border bg-card p-[3px] z-[100]"
    >
      <DropdownMenuItem
        v-if="!entry.downloaded"
        class="px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        @click="emit('download')"
      >
        {{ languages.MODEL_MANAGER_ACTION_DOWNLOAD }}
      </DropdownMenuItem>
      <DropdownMenuItem
        v-if="entry.downloaded && entry.absolutePath"
        class="px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        @click="emit('reveal')"
      >
        {{ languages.MODEL_MANAGER_ACTION_SHOW_IN_FOLDER }}
      </DropdownMenuItem>
      <DropdownMenuItem
        v-if="canEditCapabilities"
        class="px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        @click="emit('edit')"
      >
        {{ languages.MODEL_MANAGER_ACTION_EDIT_CAPABILITIES }}
      </DropdownMenuItem>
      <DropdownMenuItem
        v-if="canEditCapabilities && entry.hasCapabilityOverrides"
        class="px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        @click="emit('reset-capabilities')"
      >
        {{ languages.MODEL_MANAGER_ACTION_RESET_CAPABILITIES }}
      </DropdownMenuItem>
      <DropdownMenuSeparator class="bg-border" />
      <DropdownMenuItem
        class="px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        @click="emit('toggle-favorite')"
      >
        {{
          entry.favorite
            ? languages.MODEL_MANAGER_ACTION_UNFAVORITE
            : languages.MODEL_MANAGER_ACTION_FAVORITE
        }}
      </DropdownMenuItem>
      <DropdownMenuItem
        class="px-3 py-1.5 text-sm text-foreground hover:bg-muted"
        @click="emit('toggle-hidden')"
      >
        {{
          entry.hidden ? languages.MODEL_MANAGER_ACTION_UNHIDE : languages.MODEL_MANAGER_ACTION_HIDE
        }}
      </DropdownMenuItem>
      <template v-if="entry.source === 'custom' || canDelete">
        <DropdownMenuSeparator class="bg-border" />
        <DropdownMenuItem
          v-if="entry.source === 'custom'"
          class="px-3 py-1.5 text-sm text-foreground hover:bg-muted"
          @click="emit('remove-from-list')"
        >
          {{ languages.MODEL_MANAGER_ACTION_REMOVE_FROM_LIST }}
        </DropdownMenuItem>
        <DropdownMenuItem
          v-if="canDelete"
          class="px-3 py-1.5 text-sm text-destructive hover:bg-destructive/10"
          @click="emit('delete')"
        >
          {{ languages.MODEL_MANAGER_ACTION_DELETE }}
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>
