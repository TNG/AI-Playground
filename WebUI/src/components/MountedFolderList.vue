<template>
  <div class="flex flex-col gap-2">
    <ul
      v-if="rows.length > 0"
      class="flex flex-col gap-1"
      :aria-label="languages.AGENT_SETTINGS_MOUNTED_FOLDERS"
    >
      <li
        v-for="row in rows"
        :key="row.folder.hostPath"
        class="flex items-center gap-2 rounded-sm border border-border px-2 py-1.5"
      >
        <FolderIcon class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span class="flex min-w-0 flex-1 flex-col">
          <span class="text-sm text-foreground">{{ row.sandboxPath }}</span>
          <span class="text-xs text-muted-foreground break-all">{{ row.folder.hostPath }}</span>
        </span>
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
          <Switch
            :model-value="row.access === 'read-write'"
            :aria-label="allowChangesLabel(row.sandboxPath)"
            @update:model-value="(writable: boolean) => setWritable(row.folder, writable)"
          />
          {{
            row.access === 'read-write'
              ? languages.AGENT_SETTINGS_MOUNTED_FOLDER_READ_WRITE
              : languages.AGENT_SETTINGS_MOUNTED_FOLDER_READ_ONLY
          }}
        </label>
        <Tooltip>
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon"
              class="h-8 w-8"
              :aria-label="removeLabel(row.sandboxPath)"
              @click="remove(row.folder)"
            >
              <TrashIcon class="size-4" aria-hidden="true" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{{ languages.AGENT_SETTINGS_MOUNTED_FOLDER_REMOVE }}</TooltipContent>
        </Tooltip>
      </li>
    </ul>
    <p v-else class="text-xs text-muted-foreground italic">
      {{ languages.AGENT_SETTINGS_MOUNTED_FOLDERS_EMPTY }}
    </p>
    <div>
      <Button variant="secondary" class="px-3 py-1.5 rounded text-sm" @click="add">
        <PlusIcon class="size-4" aria-hidden="true" />
        {{ languages.AGENT_SETTINGS_MOUNTED_FOLDER_ADD }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { FolderIcon, PlusIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { MOUNTED_FOLDERS_ROOT, resolveMountedFolders } from '@/lib/mountedFolders'
import type { MountedFolder } from '@/types/agentSessionIpc'

const folders = defineModel<MountedFolder[]>({ required: true })

const languages = useI18N().state

const rows = computed(() => {
  const resolved = resolveMountedFolders(folders.value)
  return folders.value.map((folder, index) => ({
    folder,
    sandboxPath: `${MOUNTED_FOLDERS_ROOT}/${resolved[index].name}`,
    access: resolved[index].access,
  }))
})

function removeLabel(sandboxPath: string): string {
  return languages.AGENT_SETTINGS_MOUNTED_FOLDER_REMOVE_NAMED.replace('{folder}', sandboxPath)
}

async function add(): Promise<void> {
  const result = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
  const hostPath = result.canceled ? undefined : result.filePaths[0]
  if (!hostPath || folders.value.some((folder) => folder.hostPath === hostPath)) return
  folders.value = [...folders.value, { hostPath, access: 'read-only' }]
}

function allowChangesLabel(sandboxPath: string): string {
  return languages.AGENT_SETTINGS_MOUNTED_FOLDER_ALLOW_CHANGES_NAMED.replace(
    '{folder}',
    sandboxPath,
  )
}

function setWritable(target: MountedFolder, writable: boolean): void {
  const access = writable ? 'read-write' : 'read-only'
  folders.value = folders.value.map((folder) =>
    folder === target ? { ...folder, access } : folder,
  )
}

function remove(target: MountedFolder): void {
  folders.value = folders.value.filter((folder) => folder !== target)
}
</script>
