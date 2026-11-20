<template>
  <section v-if="list" class="flex flex-col gap-2">
    <SettingsHeading>{{ languages.SESSION_FOLDERS }}</SettingsHeading>
    <p class="text-xs text-muted-foreground">{{ languages.SESSION_FOLDERS_HINT }}</p>
    <p v-if="agentMode.unsandboxed" class="text-xs text-warning">
      {{ languages.AGENT_SETTINGS_MOUNTED_FOLDERS_REAL_SHELL_NOTE }}
    </p>
    <div
      v-if="missing"
      role="alert"
      class="flex flex-col gap-2 rounded-sm border border-warning px-2 py-1.5"
    >
      <p class="text-xs text-warning">{{ missingText }}</p>
      <div class="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          class="px-3 py-1.5 rounded text-sm"
          :disabled="busy || demo"
          @click="locate"
        >
          {{ languages.SESSION_WORKSPACE_LOCATE }}
        </Button>
        <Button
          variant="secondary"
          class="px-3 py-1.5 rounded text-sm"
          :disabled="busy"
          @click="startNew"
        >
          {{
            missing.fallback
              ? languages.SESSION_WORKSPACE_USE_OWN
              : languages.SESSION_WORKSPACE_START_NEW
          }}
        </Button>
      </div>
    </div>
    <TooltipProvider :delay-duration="200">
      <ul
        class="grid grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] gap-y-1"
        :aria-label="languages.SESSION_FOLDERS"
      >
        <li
          v-for="row in rows"
          :key="row.folder.id"
          class="col-span-full grid grid-cols-subgrid items-center gap-x-2 rounded-sm border border-border px-2 py-1.5"
        >
          <Tooltip v-if="row.workspace">
            <TooltipTrigger as-child>
              <span class="flex h-8 w-8 items-center justify-center">
                <StarIcon
                  class="size-4 text-primary"
                  role="img"
                  :aria-label="languages.SESSION_FOLDER_WORKSPACE"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>{{ languages.SESSION_FOLDER_WORKSPACE }}</TooltipContent>
          </Tooltip>
          <Tooltip v-else>
            <TooltipTrigger as-child>
              <span>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-8 w-8"
                  :disabled="busy || demo"
                  :aria-label="makeWorkspaceLabel(row.name)"
                  @click="star(row.folder.id, row.name)"
                >
                  <StarOutlineIcon class="size-4" aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {{
                demo
                  ? languages.SESSION_FOLDER_DEMO_DISABLED
                  : busy
                    ? languages.SESSION_FOLDER_MAKE_WORKSPACE_BUSY
                    : languages.SESSION_FOLDER_MAKE_WORKSPACE
              }}
            </TooltipContent>
          </Tooltip>
          <span class="flex min-w-0 flex-col">
            <span class="text-sm text-foreground">{{ row.name }}</span>
            <span class="text-xs text-muted-foreground break-all">{{ row.folder.hostPath }}</span>
          </span>
          <label
            class="flex items-center justify-end gap-1.5 text-xs text-muted-foreground whitespace-nowrap"
          >
            {{
              row.writable
                ? languages.AGENT_SETTINGS_MOUNTED_FOLDER_READ_WRITE
                : languages.AGENT_SETTINGS_MOUNTED_FOLDER_READ_ONLY
            }}
            <Switch
              :model-value="row.writable"
              :disabled="row.workspace"
              :aria-label="allowChangesLabel(row.name)"
              @update:model-value="(writable: boolean) => setWritable(row.folder.id, writable)"
            />
          </label>
          <Tooltip>
            <TooltipTrigger as-child>
              <Button
                variant="ghost"
                size="icon"
                class="h-8 w-8"
                :aria-label="openLabel(row.name)"
                @click="open(row.folder.id)"
              >
                <FolderOpenIcon class="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{{ languages.SESSION_FOLDER_OPEN }}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <!-- A wrapper, so the tooltip still opens on the disabled Workspace button. -->
              <span>
                <Button
                  variant="ghost"
                  size="icon"
                  class="h-8 w-8"
                  :disabled="row.workspace || row.folder.appCreated"
                  :aria-label="removeLabel(row.name)"
                  @click="remove(row.folder.id)"
                >
                  <TrashIcon class="size-4" aria-hidden="true" />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {{
                row.workspace
                  ? languages.SESSION_FOLDER_WORKSPACE_LOCKED
                  : row.folder.appCreated
                    ? languages.SESSION_FOLDER_APP_CREATED_LOCKED
                    : languages.AGENT_SETTINGS_MOUNTED_FOLDER_REMOVE
              }}
            </TooltipContent>
          </Tooltip>
        </li>
      </ul>
      <div>
        <Tooltip :disabled="!demo">
          <TooltipTrigger as-child>
            <span class="inline-flex">
              <Button
                variant="secondary"
                class="px-3 py-1.5 rounded text-sm"
                :disabled="demo"
                @click="add"
              >
                <PlusIcon class="size-4" aria-hidden="true" />
                {{ languages.AGENT_SETTINGS_MOUNTED_FOLDER_ADD }}
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>{{ languages.SESSION_FOLDER_DEMO_DISABLED }}</TooltipContent>
        </Tooltip>
      </div>
    </TooltipProvider>
    <p v-if="refusalText" role="alert" class="text-xs text-warning">{{ refusalText }}</p>
    <p v-if="starredNote" role="status" class="text-xs text-muted-foreground">{{ starredNote }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import {
  FolderOpenIcon,
  PlusIcon,
  StarIcon as StarOutlineIcon,
  TrashIcon,
} from '@heroicons/vue/24/outline'
import { StarIcon } from '@heroicons/vue/24/solid'
import { useAgentMode } from '@/assets/js/store/agentMode'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { useSessions } from '@/assets/js/store/sessions'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { mountedFolderRefusalText } from '@/lib/mountedFolderRefusalText'
import { folderBaseName, isWritable, type MountedFolderRefusal } from '@/lib/mountedFolders'

const languages = useI18N().state
const errors = useErrors()
const sessions = useSessions()
const agentMode = useAgentMode()
const demoMode = useDemoMode()
const refusal = ref<MountedFolderRefusal>()
const starredNote = ref('')

const sessionId = computed(() => sessions.openSessionId)
const list = computed(() => sessions.openSession?.folderList)
const busy = computed(() => sessions.openTurn !== null)
const demo = computed(() => demoMode.enabled)

const rows = computed(() =>
  (list.value?.folders ?? []).map((folder) => ({
    folder,
    name: folderBaseName(folder.hostPath) || folder.hostPath,
    workspace: folder.id === list.value?.workspaceId,
    writable: isWritable(folder),
  })),
)

const refusalText = computed(() => mountedFolderRefusalText(refusal.value, languages))

const missing = computed(() => sessions.openMissingWorkspace)
const missingText = computed(() =>
  missing.value
    ? languages.SESSION_WORKSPACE_MISSING_TEXT.replace('{folder}', missing.value.name).replace(
        '{path}',
        missing.value.hostPath,
      )
    : '',
)

async function locate(): Promise<void> {
  const id = sessionId.value
  refusal.value = undefined
  if (!id) return
  const located = await sessions.locateWorkspace(id)
  if (located !== 'located' && located !== 'cancelled') refusal.value = located
}

function startNew(): void {
  const id = sessionId.value
  if (id) void sessions.startNewWorkspace(id)
}

function removeLabel(name: string): string {
  return languages.AGENT_SETTINGS_MOUNTED_FOLDER_REMOVE_NAMED.replace('{folder}', name)
}

function allowChangesLabel(name: string): string {
  return languages.AGENT_SETTINGS_MOUNTED_FOLDER_ALLOW_CHANGES_NAMED.replace('{folder}', name)
}

async function add(): Promise<void> {
  const id = sessionId.value
  if (!id) return
  refusal.value = undefined
  try {
    const result = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
    const hostPath = result.canceled ? undefined : result.filePaths[0]
    if (hostPath) refusal.value = await sessions.addFolder(id, hostPath)
  } catch (error) {
    errors.report(error, {
      code: 'session-folders/add-failed',
      category: 'unknown',
      surface: 'toast',
      userMessage: languages.AGENT_SETTINGS_MOUNTED_FOLDER_ADD_FAILED,
    })
  }
}

function setWritable(folderId: string, writable: boolean): void {
  const id = sessionId.value
  if (id) void sessions.setFolderAccess(id, folderId, writable ? 'read-write' : 'read-only')
}

function remove(folderId: string): void {
  const id = sessionId.value
  refusal.value = undefined
  if (id) void sessions.removeFolder(id, folderId)
}

function openLabel(name: string): string {
  return languages.SESSION_FOLDER_OPEN_NAMED.replace('{folder}', name)
}

function open(folderId: string): void {
  const id = sessionId.value
  if (id) void sessions.openFolder(id, folderId)
}

function makeWorkspaceLabel(name: string): string {
  return languages.SESSION_FOLDER_MAKE_WORKSPACE_NAMED.replace('{folder}', name)
}

async function star(folderId: string, name: string): Promise<void> {
  const id = sessionId.value
  refusal.value = undefined
  starredNote.value = ''
  if (!id) return
  const starred = await sessions.starFolder(id, folderId)
  if (starred?.madeReadWrite) {
    starredNote.value = languages.SESSION_FOLDER_STARRED_READ_WRITE.replace('{folder}', name)
  }
}
</script>
