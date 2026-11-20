<template>
  <section class="flex flex-col gap-2">
    <SettingsHeading>{{ languages.AGENT_FOLDERS }}</SettingsHeading>
    <p class="text-xs text-muted-foreground">{{ languages.AGENT_FOLDERS_HINT }}</p>
    <div class="flex flex-col gap-2">
      <Label id="agent-other-folders-label" class="text-sm">
        {{ languages.AGENT_FOLDERS_OTHER }}
      </Label>
      <RadioGroup
        :model-value="overridesFolders ? 'only' : 'inherit'"
        aria-labelledby="agent-other-folders-label"
        class="flex flex-col gap-2"
        @update:model-value="(choice) => chooseOtherFolders(String(choice))"
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
import { computed } from 'vue'
import { useI18N } from '@/assets/js/store/i18n'
import MountedFolderList from '@/components/MountedFolderList.vue'
import SettingsHeading from '@/components/SettingsHeading.vue'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { agentFolderEntries, editableFolders, withOtherFolders } from '@/lib/agentFolderOverrides'
import type { AgentFolderOverrides, MountedFolder } from '@/types/agentSessionIpc'

const props = defineProps<{ overrides: AgentFolderOverrides }>()
const emit = defineEmits<{ change: [overrides: AgentFolderOverrides] }>()

const languages = useI18N().state

const overridesFolders = computed(() => props.overrides.folders !== undefined)

function chooseOtherFolders(choice: string): void {
  emit('change', withOtherFolders(props.overrides, choice === 'only' ? [] : undefined))
}

function setFolders(folders: MountedFolder[]): void {
  const entries = agentFolderEntries(folders, props.overrides.folders ?? [], () =>
    crypto.randomUUID(),
  )
  emit('change', withOtherFolders(props.overrides, entries))
}
</script>
