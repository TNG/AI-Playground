<script setup lang="ts">
import { computed, ref } from 'vue'
import { useAgentTasks, type LibraryAgent } from '@/assets/js/store/agentTasks'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { createAppError } from '@/assets/js/errors/appError'
import { presetIconFromFile } from '@/lib/presetIcon'

const props = defineProps<{ agent: LibraryAgent }>()

const agentTasks = useAgentTasks()
const errors = useErrors()
const i18n = useI18N().state

const startableFromChannel = computed(
  () => agentTasks.tasks.find((task) => task.id === props.agent.id)?.startableFromChannel === true,
)

const fileInput = ref<HTMLInputElement | null>(null)

async function pickImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    await agentTasks.editDraft(props.agent.id, { image: await presetIconFromFile(file) })
  } catch (error) {
    errors.report(
      createAppError({
        category: 'validation',
        code: 'agent-library/image-unreadable',
        severity: 'warning',
        surface: 'toast',
        userMessage: i18n.AGENT_LIBRARY_IMAGE_FAILED,
        technicalMessage: String(error),
      }),
    )
  }
}
</script>

<template>
  <section class="flex flex-col gap-4" :aria-label="i18n.AGENT_LIBRARY_DETAILS">
    <div class="flex flex-col gap-1.5">
      <Label for="agent-library-name">{{ i18n.AGENT_LIBRARY_NAME }}</Label>
      <Input
        id="agent-library-name"
        autocomplete="off"
        class="max-w-md"
        :model-value="agent.name"
        :placeholder="i18n.AGENT_LIBRARY_UNNAMED"
        @update:model-value="(name) => agentTasks.editDraft(agent.id, { name: String(name) })"
      />
    </div>
    <div class="flex flex-col gap-1.5">
      <Label for="agent-library-description">{{ i18n.AGENT_LIBRARY_DESCRIPTION }}</Label>
      <Textarea
        id="agent-library-description"
        rows="2"
        class="max-w-xl"
        :model-value="agent.description ?? ''"
        :placeholder="i18n.AGENT_LIBRARY_DESCRIPTION_PLACEHOLDER"
        @update:model-value="
          (text) => agentTasks.editDraft(agent.id, { description: String(text) || undefined })
        "
      />
    </div>
    <!-- Written at once to the saved Agent, unlike the Draft fields around it. -->
    <label
      class="flex max-w-xl items-start gap-3 rounded-md bg-muted px-3 py-2"
      :class="{ 'opacity-60': !agent.saved }"
    >
      <Switch
        :model-value="startableFromChannel"
        :disabled="!agent.saved"
        :aria-label="i18n.AGENT_LIBRARY_STARTABLE_FROM_CHANNEL"
        aria-describedby="agent-library-startable-info"
        @update:model-value="
          (startable: boolean) => agentTasks.setStartableFromChannel(agent.id, startable)
        "
      />
      <span class="flex min-w-0 flex-1 flex-col">
        <span class="text-sm">{{ i18n.AGENT_LIBRARY_STARTABLE_FROM_CHANNEL }}</span>
        <span id="agent-library-startable-info" class="text-xs text-muted-foreground">
          {{
            agent.saved
              ? i18n.AGENT_LIBRARY_STARTABLE_FROM_CHANNEL_INFO
              : i18n.AGENT_LIBRARY_STARTABLE_FROM_CHANNEL_SAVE_FIRST
          }}
        </span>
      </span>
    </label>
    <div class="flex flex-col gap-1.5">
      <span id="agent-library-image" class="text-sm font-medium">
        {{ i18n.AGENT_LIBRARY_IMAGE }}
      </span>
      <div role="group" aria-labelledby="agent-library-image" class="flex items-center gap-3">
        <img
          v-if="agent.image"
          :src="agent.image"
          :alt="i18n.AGENT_LIBRARY_IMAGE"
          class="size-16 flex-none rounded-md object-cover ring-1 ring-border"
        />
        <Button type="button" variant="secondary" size="sm" @click="fileInput?.click()">
          {{ i18n.AGENT_LIBRARY_IMAGE_CHOOSE }}
        </Button>
        <Button
          v-if="agent.image"
          type="button"
          variant="ghost"
          size="sm"
          @click="agentTasks.editDraft(agent.id, { image: undefined })"
        >
          {{ i18n.AGENT_LIBRARY_IMAGE_REMOVE }}
        </Button>
        <input
          ref="fileInput"
          type="file"
          accept="image/png,image/jpeg,image/webp"
          class="hidden"
          tabindex="-1"
          aria-hidden="true"
          @change="pickImage"
        />
      </div>
    </div>
  </section>
</template>
