<template>
  <div class="flex flex-col gap-3 text-xs text-foreground">
    <div v-for="warning in warnings.certain" :key="warning.kind" class="flex flex-col gap-1">
      <p class="font-medium">{{ certainText(warning) }}</p>
      <ul class="flex flex-col gap-0.5 pl-3 text-muted-foreground">
        <li v-for="model in warning.models" :key="model.repo_id" class="break-all">
          {{ model.repo_id }}
        </li>
      </ul>
      <Button
        v-if="actions"
        variant="secondary"
        size="sm"
        class="self-start mt-1"
        :disabled="downloading"
        @click="emit('download', [warning])"
      >
        {{ i18n.AGENT_TASK_MODELS_DOWNLOAD_NOW }}
      </Button>
    </div>

    <div v-if="warnings.maybe.length > 0" class="flex flex-col gap-1">
      <p class="font-medium">{{ i18n.AGENT_TASK_MODELS_MAYBE_TITLE }}</p>
      <ul class="flex flex-col gap-1">
        <li v-for="warning in warnings.maybe" :key="needLabel(warning)" class="flex flex-col">
          <span>{{ needLabel(warning) }}</span>
          <ul class="flex flex-col gap-0.5 pl-3 text-muted-foreground">
            <li v-for="model in warning.models" :key="model.repo_id" class="break-all">
              {{ model.repo_id }}
            </li>
          </ul>
        </li>
      </ul>
      <p class="text-muted-foreground">
        {{ i18n.AGENT_TASK_MODELS_OTHER_WORKFLOWS }} {{ i18n.AGENT_TASK_MODELS_TEST_RUN_HINT }}
      </p>
      <Button
        v-if="actions"
        variant="secondary"
        size="sm"
        class="self-start mt-1"
        :disabled="downloading"
        @click="emit('download', warnings.maybe)"
      >
        {{ i18n.AGENT_TASK_MODELS_DOWNLOAD_THESE }}
      </Button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import type {
  MediaTool,
  MediaType,
  SpeechTool,
  TaskModelWarning,
  TaskModelWarnings,
} from '@/lib/taskModelNeeds'

defineProps<{
  warnings: TaskModelWarnings
  actions?: boolean
  downloading?: boolean
}>()

const emit = defineEmits<{ download: [list: readonly TaskModelWarning[]] }>()

const i18n = useI18N().state

const CERTAIN_TEXT_KEYS: Partial<Record<TaskModelWarning['kind'], string>> = {
  chat: 'AGENT_TASK_MODELS_CHAT_MISSING',
  embedding: 'AGENT_TASK_MODELS_EMBEDDING_MISSING',
}

function certainText(warning: TaskModelWarning): string {
  const key = CERTAIN_TEXT_KEYS[warning.kind]
  return key ? i18n[key] : warning.kind
}

const NEED_LABEL_KEYS: Record<`${MediaTool}:${MediaType}` | SpeechTool, string> = {
  'comfyUI:image': 'AGENT_TASK_MODELS_TEXT_TO_IMAGE',
  'comfyUI:video': 'AGENT_TASK_MODELS_TEXT_TO_VIDEO',
  'comfyUI:model3d': 'AGENT_TASK_MODELS_TEXT_TO_3D',
  'comfyUiImageEdit:image': 'AGENT_TASK_MODELS_IMAGE_TO_IMAGE',
  'comfyUiImageEdit:video': 'AGENT_TASK_MODELS_IMAGE_TO_VIDEO',
  'comfyUiImageEdit:model3d': 'AGENT_TASK_MODELS_IMAGE_TO_3D',
  synthesizeTextToSpeech: 'AGENT_TASK_MODELS_TEXT_TO_SPEECH',
  transcribeAudio: 'AGENT_TASK_MODELS_SPEECH_TO_TEXT',
}

function needLabel(warning: TaskModelWarning): string {
  if (warning.kind === 'workflow') {
    const label = i18n[NEED_LABEL_KEYS[`${warning.tool}:${warning.mediaType}`]]
    return `${label} · ${warning.workflow}`
  }
  if (warning.kind === 'speech') return i18n[NEED_LABEL_KEYS[warning.tool]]
  return warning.kind
}
</script>
