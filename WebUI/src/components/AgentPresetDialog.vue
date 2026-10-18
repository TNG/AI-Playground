<template>
  <Dialog v-model:open="open">
    <DialogContent class="max-w-md max-h-[90vh] overflow-y-auto">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription>{{ i18n.AGENT_PRESET_DIALOG_DESCRIPTION }}</DialogDescription>
      </DialogHeader>
      <form class="flex flex-col gap-4" @submit.prevent="save">
        <div class="flex flex-col gap-1.5">
          <Label for="agent-preset-description">{{ i18n.AGENT_PRESET_DESCRIPTION }}</Label>
          <Textarea
            id="agent-preset-description"
            v-model="description"
            rows="3"
            :placeholder="i18n.AGENT_PRESET_DESCRIPTION_PLACEHOLDER"
          />
        </div>
        <div class="flex flex-col gap-1.5">
          <span id="agent-preset-icon" class="text-sm font-medium text-foreground">
            {{ i18n.AGENT_PRESET_ICON }}
          </span>
          <div role="group" aria-labelledby="agent-preset-icon" class="flex items-center gap-3">
            <img
              v-if="shownImage"
              :src="shownImage"
              :alt="i18n.AGENT_PRESET_ICON"
              class="size-16 flex-none rounded-md object-cover ring-1 ring-border"
            />
            <div class="flex flex-wrap gap-2">
              <Button type="button" variant="secondary" size="sm" @click="fileInput?.click()">
                {{ i18n.AGENT_PRESET_ICON_CHOOSE }}
              </Button>
              <Button
                v-if="image"
                type="button"
                variant="ghost"
                size="sm"
                @click="image = undefined"
              >
                {{ i18n.AGENT_PRESET_ICON_DEFAULT }}
              </Button>
            </div>
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
        <DialogFooter class="gap-2">
          <Button
            v-if="existing"
            type="button"
            variant="destructive"
            class="sm:mr-auto"
            :disabled="busy"
            @click="remove"
          >
            {{ i18n.AGENT_PRESET_REMOVE }}
          </Button>
          <Button type="button" variant="ghost" @click="open = false">
            {{ i18n.COM_CANCEL }}
          </Button>
          <Button type="submit" :disabled="!description.trim() || busy">
            {{ existing ? i18n.AGENT_PRESET_UPDATE : i18n.AGENT_PRESET_ADD }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useAgentTasks } from '@/assets/js/store/agentTasks'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { usePresets } from '@/assets/js/store/presets'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createAppError } from '@/assets/js/errors/appError'
import { presetIconFromFile } from '@/lib/presetIcon'
import { AGENT_PRESET } from '@/assets/js/store/agentModeSessions'
import * as toast from '@/assets/js/toast'

const props = defineProps<{
  taskId: string | null
}>()

const open = defineModel<boolean>('open', { required: true })

const agentTasks = useAgentTasks()
const errors = useErrors()
const presets = usePresets()
const i18n = useI18N().state

function fill(template: string, name: string): string {
  return template.replace('{name}', name)
}

const task = computed(() => agentTasks.tasks.find((entry) => entry.id === props.taskId))
const existing = computed(() => (props.taskId ? agentTasks.presetOfAgent(props.taskId) : undefined))
const presetName = computed(() => existing.value?.name ?? task.value?.name ?? '')
const title = computed(() =>
  fill(
    existing.value ? i18n.AGENT_PRESET_DIALOG_EDIT_TITLE : i18n.AGENT_PRESET_DIALOG_TITLE,
    presetName.value,
  ),
)

const description = ref('')
const image = ref<string | undefined>(undefined)
const busy = ref(false)
const fileInput = ref<HTMLInputElement | null>(null)

const defaultImage = computed(
  () => presets.presets.find((preset) => preset.name === AGENT_PRESET)?.image,
)
const shownImage = computed(() => image.value ?? defaultImage.value)

watch(open, (isOpen) => {
  if (!isOpen) return
  description.value = existing.value?.description ?? ''
  const current = existing.value?.image
  image.value = current && current !== defaultImage.value ? current : undefined
})

async function pickImage(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  try {
    image.value = await presetIconFromFile(file)
  } catch (error) {
    errors.report(
      createAppError({
        category: 'validation',
        code: 'agent-preset/icon-unreadable',
        severity: 'warning',
        surface: 'toast',
        userMessage: i18n.AGENT_PRESET_ICON_FAILED,
        technicalMessage: String(error),
      }),
    )
  }
}

async function save(): Promise<void> {
  if (!props.taskId || !description.value.trim()) return
  busy.value = true
  try {
    const wasExisting = !!existing.value
    const result = await agentTasks.saveAgentAsPreset(props.taskId, {
      description: description.value,
      ...(image.value ? { image: image.value } : {}),
    })
    if (!result.ok) {
      errors.report(
        createAppError({
          category: 'validation',
          code: `agent-preset/${result.reason}`,
          severity: 'warning',
          surface: 'toast',
          userMessage:
            result.reason === 'name-taken'
              ? fill(i18n.AGENT_PRESET_NAME_TAKEN, presetName.value)
              : i18n.AGENT_PRESET_SAVE_FAILED,
        }),
      )
      return
    }
    toast.success(
      fill(wasExisting ? i18n.AGENT_PRESET_UPDATED : i18n.AGENT_PRESET_SAVED, result.preset.name),
    )
    open.value = false
  } finally {
    busy.value = false
  }
}

async function remove(): Promise<void> {
  if (!props.taskId) return
  const name = presetName.value
  busy.value = true
  try {
    if (await agentTasks.removeAgentPreset(props.taskId)) {
      toast.success(fill(i18n.AGENT_PRESET_REMOVED, name))
      open.value = false
    } else {
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-preset/remove-failed',
          surface: 'toast',
          userMessage: i18n.AGENT_PRESET_SAVE_FAILED,
        }),
      )
    }
  } finally {
    busy.value = false
  }
}
</script>
