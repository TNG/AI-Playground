<template>
  <div class="flex flex-col gap-2">
    <p v-if="realShell" class="text-xs text-amber-500">
      {{ languages.AGENT_SETTINGS_MOUNTED_FOLDERS_REAL_SHELL_NOTE }}
    </p>
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
        <Input
          class="h-7 w-28 shrink-0 px-2"
          :model-value="row.folder.name ?? ''"
          :placeholder="folderBaseName(row.folder.hostPath)"
          :aria-label="nameLabel(row.folder.hostPath)"
          @change="rename(row.folder, ($event.target as HTMLInputElement).value)"
        />
        <label class="flex items-center gap-1.5 text-xs text-muted-foreground whitespace-nowrap">
          <Switch
            :model-value="row.writable"
            :aria-label="allowChangesLabel(row.sandboxPath)"
            @update:model-value="(writable: boolean) => setWritable(row.folder, writable)"
          />
          {{
            row.writable
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
    <p v-if="refusalText" role="alert" class="text-xs text-amber-500">{{ refusalText }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { FolderIcon, PlusIcon, TrashIcon } from '@heroicons/vue/24/outline'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  folderBaseName,
  isWritable,
  mountedFolderRefusal,
  mountedFolderSandboxPath,
  resolveMountedFolders,
  type MountedFolderRefusal,
} from '@/lib/mountedFolders'
import type { MountedFolder } from '@/types/agentSessionIpc'

const props = defineProps<{
  /** Absent where there is no Session Folder to overlap, as in an Agent's Settings Template. */
  sessionFolder?: string
  /** The real system shell, where read-only is not enforced. */
  realShell?: boolean
}>()

const folders = defineModel<MountedFolder[]>({ required: true })

const languages = useI18N().state
const errors = useErrors()
const refusal = ref<MountedFolderRefusal>()

const rows = computed(() => {
  const resolved = resolveMountedFolders(folders.value)
  return folders.value.map((folder, index) => ({
    folder,
    sandboxPath: mountedFolderSandboxPath(resolved[index]),
    writable: isWritable(resolved[index]),
  }))
})

const refusalText = computed(() => {
  const refused = refusal.value
  if (!refused) return ''
  if (refused.reason === 'mounted') {
    return languages.AGENT_SETTINGS_MOUNTED_FOLDER_REFUSED_MOUNTED.replace(
      '{folder}',
      refused.folder,
    )
  }
  if (refused.reason === 'contains-mounted') {
    return languages.AGENT_SETTINGS_MOUNTED_FOLDER_REFUSED_CONTAINS_MOUNTED.replaceAll(
      '{folder}',
      refused.folder,
    )
  }
  return {
    'too-broad': languages.AGENT_SETTINGS_MOUNTED_FOLDER_REFUSED_TOO_BROAD,
    home: languages.AGENT_SETTINGS_MOUNTED_FOLDER_REFUSED_HOME,
    'session-folder': languages.AGENT_SETTINGS_MOUNTED_FOLDER_REFUSED_SESSION_FOLDER,
  }[refused.reason]
})

function removeLabel(sandboxPath: string): string {
  return languages.AGENT_SETTINGS_MOUNTED_FOLDER_REMOVE_NAMED.replace('{folder}', sandboxPath)
}

function nameLabel(hostPath: string): string {
  return languages.AGENT_SETTINGS_MOUNTED_FOLDER_NAME_LABEL.replace('{folder}', hostPath)
}

async function add(): Promise<void> {
  refusal.value = undefined
  let hostPath: string | undefined
  try {
    const result = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
    hostPath = result.canceled ? undefined : result.filePaths[0]
    if (!hostPath) return
    refusal.value = mountedFolderRefusal(hostPath, {
      homeFolder: await window.electronAPI.getHomePath(),
      sessionFolder: props.sessionFolder || undefined,
      mountedFolders: folders.value,
    })
  } catch (error) {
    errors.report(error, {
      code: 'mounted-folders/add-failed',
      category: 'unknown',
      surface: 'toast',
      userMessage: languages.AGENT_SETTINGS_MOUNTED_FOLDER_ADD_FAILED,
    })
    return
  }
  if (refusal.value) return
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

function rename(target: MountedFolder, raw: string): void {
  const name = raw.trim()
  if (name === (target.name ?? '')) return
  folders.value = folders.value.map((folder) => {
    if (folder !== target) return folder
    const { name: _previous, ...rest } = folder
    return name ? { ...rest, name } : rest
  })
}

function remove(target: MountedFolder): void {
  refusal.value = undefined
  folders.value = folders.value.filter((folder) => folder !== target)
}
</script>
