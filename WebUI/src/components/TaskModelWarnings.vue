<template>
  <div
    v-if="certain.length > 0 || maybe.length > 0 || downloadError"
    role="group"
    :aria-label="i18n.AGENT_TASK_MODELS_REGION"
    class="flex flex-col gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-3 text-xs text-foreground"
  >
    <div v-for="warning in certain" :key="warning.kind" class="flex flex-col gap-1.5">
      <p>{{ i18n.AGENT_TASK_MODELS_EMBEDDING_MISSING }}</p>
      <ul class="flex flex-col gap-0.5 pl-3">
        <li v-for="model in warning.models" :key="model.repo_id" class="break-all">
          {{ modelLine(model) }}
        </li>
      </ul>
      <Button
        variant="secondary"
        size="sm"
        class="self-start"
        :disabled="downloading"
        @click="download([warning])"
      >
        {{ i18n.AGENT_TASK_MODELS_DOWNLOAD_NOW }}
      </Button>
    </div>

    <div v-if="maybe.length > 0" class="flex flex-col gap-1.5">
      <p class="font-medium">{{ i18n.AGENT_TASK_MODELS_MAYBE_TITLE }}</p>
      <ul class="flex flex-col gap-1.5">
        <li v-for="warning in maybe" :key="needLabel(warning)" class="flex flex-col gap-0.5">
          <span>{{ needLabel(warning) }}</span>
          <ul class="flex flex-col gap-0.5 pl-3 text-muted-foreground">
            <li v-for="model in warning.models" :key="model.repo_id" class="break-all">
              {{ modelLine(model) }}
            </li>
          </ul>
        </li>
      </ul>
      <p class="text-muted-foreground">{{ i18n.AGENT_TASK_MODELS_OTHER_WORKFLOWS }}</p>
      <p class="text-muted-foreground">{{ i18n.AGENT_TASK_MODELS_TEST_RUN_HINT }}</p>
      <Button
        variant="secondary"
        size="sm"
        class="self-start"
        :disabled="downloading"
        @click="download(maybe)"
      >
        {{ i18n.AGENT_TASK_MODELS_DOWNLOAD_THESE }}
      </Button>
    </div>

    <p v-if="downloadError" role="alert" class="text-destructive">{{ downloadError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import { useI18N } from '@/assets/js/store/i18n'
import { Button } from '@/components/ui/button'
import { useTaskModelWarnings } from '@/assets/js/taskModelWarnings'
import type {
  MediaTool,
  MediaType,
  MissingModel,
  SpeechTool,
  TaskModelWarning,
} from '@/lib/taskModelNeeds'

const props = defineProps<{ template: AgentSessionSettings | null | undefined }>()

const i18n = useI18N().state

const { warnings, downloading, downloadError, download } = useTaskModelWarnings(
  () => props.template,
)

const certain = computed(() => warnings.value.certain)
const maybe = computed(() => warnings.value.maybe)

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

function modelLine(model: MissingModel): string {
  return model.size ? `${model.repo_id} (${model.size})` : model.repo_id
}
</script>
