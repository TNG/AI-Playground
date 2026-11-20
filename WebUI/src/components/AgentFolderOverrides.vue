<template>
  <section class="flex flex-col gap-2">
    <SettingsHeading>{{ languages.AGENT_FOLDERS }}</SettingsHeading>
    <p class="text-xs text-muted-foreground">{{ languages.AGENT_FOLDERS_HINT }}</p>
    <div class="flex flex-col gap-2">
      <Label id="agent-workspace-label" class="text-sm">
        {{ languages.AGENT_FOLDERS_WORKSPACE }}
      </Label>
      <RadioGroup
        :model-value="overrides.workspace ? 'own' : 'inherit'"
        aria-labelledby="agent-workspace-label"
        class="flex flex-col gap-2"
        @update:model-value="(choice) => chooseWorkspace(choice as WorkspaceChoice)"
      >
        <div class="flex items-center gap-2">
          <RadioGroupItem id="agent-workspace-inherit" value="inherit" />
          <Label for="agent-workspace-inherit" class="cursor-pointer font-normal">
            {{ languages.AGENT_FOLDERS_WORKSPACE_INHERIT }}
          </Label>
        </div>
        <div class="flex min-w-0 items-center gap-2">
          <RadioGroupItem id="agent-workspace-own" value="own" :disabled="demo" />
          <Label for="agent-workspace-own" class="cursor-pointer font-normal whitespace-nowrap">
            {{ languages.AGENT_FOLDERS_WORKSPACE_OWN }}
          </Label>
          <span
            v-if="overrides.workspace"
            class="flex min-w-0 items-center gap-1 text-sm text-foreground"
          >
            <FolderIcon class="size-4 flex-none text-muted-foreground" aria-hidden="true" />
            <span class="break-all">{{ overrides.workspace.hostPath }}</span>
          </span>
          <Button
            variant="secondary"
            class="px-3 py-1 rounded text-sm"
            :disabled="demo"
            :aria-label="languages.AGENT_FOLDERS_WORKSPACE_CHOOSE_LABEL"
            @click="pickWorkspace"
          >
            {{ languages.AGENT_FOLDERS_WORKSPACE_CHOOSE }}
          </Button>
        </div>
      </RadioGroup>
      <p v-if="refusalText" role="alert" class="text-xs text-warning">{{ refusalText }}</p>
    </div>
    <div class="flex flex-col gap-2">
      <Label id="agent-other-folders-label" class="text-sm">
        {{ languages.AGENT_FOLDERS_OTHER }}
      </Label>
      <RadioGroup
        :model-value="overridesFolders ? 'only' : 'inherit'"
        aria-labelledby="agent-other-folders-label"
        class="flex flex-col gap-2"
        @update:model-value="(choice) => chooseOtherFolders(choice as OtherFoldersChoice)"
      >
        <div class="flex items-center gap-2">
          <RadioGroupItem id="agent-other-folders-inherit" value="inherit" />
          <Label for="agent-other-folders-inherit" class="cursor-pointer font-normal">
            {{ languages.AGENT_FOLDERS_OTHER_INHERIT }}
          </Label>
        </div>
        <div class="flex items-center gap-2">
          <RadioGroupItem id="agent-other-folders-only" value="only" />
          <Label for="agent-other-folders-only" class="cursor-pointer font-normal">
            {{ languages.AGENT_FOLDERS_OTHER_ONLY }}
          </Label>
        </div>
      </RadioGroup>
      <MountedFolderList
        v-if="overridesFolders"
        :model-value="editableFolders(overrides.folders ?? [])"
        @update:model-value="setFolders"
      />
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { FolderIcon } from '@heroicons/vue/24/outline'
import { useDemoMode } from '@/assets/js/store/demoMode'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import MountedFolderList from '@/components/MountedFolderList.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  agentFolderEntries,
  editableFolders,
  withOtherFolders,
  withWorkspace,
} from '@/lib/agentFolderOverrides'
import { mountedFolderRefusalText } from '@/lib/mountedFolderRefusalText'
import { mountedFolderRefusal, type MountedFolderRefusal } from '@/lib/mountedFolders'
import type { AgentFolderOverrides, MountedFolder } from '@/types/agentSessionIpc'

type WorkspaceChoice = 'inherit' | 'own'
type OtherFoldersChoice = 'inherit' | 'only'

const props = defineProps<{ overrides: AgentFolderOverrides }>()
const emit = defineEmits<{ change: [overrides: AgentFolderOverrides] }>()

const languages = useI18N().state
const errors = useErrors()
const demoMode = useDemoMode()
const demo = computed(() => demoMode.enabled)
const refusal = ref<MountedFolderRefusal>()
const refusalText = computed(() => mountedFolderRefusalText(refusal.value, languages))

function chooseWorkspace(choice: WorkspaceChoice): void {
  refusal.value = undefined
  if (choice === 'own') void pickWorkspace()
  else emit('change', withWorkspace(props.overrides, undefined, newId))
}

async function pickWorkspace(): Promise<void> {
  refusal.value = undefined
  try {
    const result = await window.electronAPI.showOpenDialog({ properties: ['openDirectory'] })
    const hostPath = result.canceled ? undefined : result.filePaths[0]
    if (!hostPath) return
    refusal.value = mountedFolderRefusal(hostPath, {
      homeFolder: await window.electronAPI.getHomePath(),
      mountedFolders: editableFolders(props.overrides.folders ?? []),
    })
    if (!refusal.value) emit('change', withWorkspace(props.overrides, hostPath, newId))
  } catch (error) {
    errors.report(error, {
      code: 'agent-folders/choose-workspace-failed',
      category: 'unknown',
      surface: 'toast',
      userMessage: languages.AGENT_SETTINGS_MOUNTED_FOLDER_ADD_FAILED,
    })
  }
}

function newId(): string {
  return crypto.randomUUID()
}

const overridesFolders = computed(() => props.overrides.folders !== undefined)

function chooseOtherFolders(choice: OtherFoldersChoice): void {
  emit('change', withOtherFolders(props.overrides, choice === 'only' ? [] : undefined))
}

function setFolders(folders: MountedFolder[]): void {
  const entries = agentFolderEntries(folders, props.overrides.folders ?? [], newId)
  emit('change', withOtherFolders(props.overrides, entries))
}
</script>
