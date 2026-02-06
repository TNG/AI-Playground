<template>
  <div class="dialog-container z-10">
    <div
      class="dialog-mask absolute left-0 top-0 w-full h-full bg-background/55 flex justify-center items-center"
    >
      <div
        class="py-10 px-20 w-500px flex flex-col items-center justify-center bg-card rounded-3xl gap-6 text-foreground"
        :class="{ 'animate-scale-in': animate }"
      >
        <b v-html="i18nState.REQUEST_LLM_MODEL_NAME"></b>
        <div
          class="w-full flex flex-col items-center gap-2 p-4 border border-yellow-600 bg-yellow-600/10 rounded-lg"
        >
          <p>{{ i18nState.REQUEST_LLM_MODEL_DISCLAIMER_1 }}</p>
          <p>{{ i18nState.REQUEST_LLM_MODEL_DISCLAIMER_2 }}</p>
        </div>
        <div class="w-full container flex">
          <span
            @mouseover="showInfo = true"
            @mouseout="showInfo = false"
            style="vertical-align: middle"
            class="svg-icon i-info w-7 h-7 px-6"
          ></span>
          <Input
            :placeholder="examplePlaceholder"
            v-model="modelRequest"
            @keyup.enter="addModel"
          ></Input>
        </div>
        <span v-if="showInfo" class="hover-box w-0.6">
          <p v-html="i18nState.REQUEST_LLM_MODEL_DESCRIPTION"></p>
          <ul>
            <li>{{ exampleModelName }}</li>
          </ul>
        </span>
        <div
          v-if="textInference.backend === 'llamaCPP'"
          class="w-full text-sm italic text-muted-foreground text-left"
        >
          <p>{{ i18nState.REQUEST_LLM_VISION_MODEL_INFO }}</p>
        </div>
        <p v-show="addModelError" style="color: #f44336">{{ addModelErrorMessage }}</p>
        <div class="flex justify-center items-center gap-9">
          <button @click="closeAdd" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_CLOSE }}
          </button>
          <button @click="addModel" class="bg-muted text-foreground py-1 px-4 rounded">
            {{ i18nState.COM_ADD }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Input } from '@/components/ui/aipgInput'
import { useI18N } from '@/assets/js/store/i18n'
import { useModels } from '@/assets/js/store/models'
import { useTextInference } from '@/assets/js/store/textInference'
import { useDialogStore } from '@/assets/js/store/dialogs'
import type { DownloadModelParam } from '@/env'

const i18nState = useI18N().state
const textInference = useTextInference()
const models = useModels()
const modelRequest = ref('')
const addModelErrorMessage = ref('')
const showInfo = ref(false)
const addModelError = ref(false)
const animate = ref(false)

const emits = defineEmits<{
  (e: 'close'): void
}>()

const exampleModelName = computed(() =>
  textInference.backend === 'llamaCPP'
    ? i18nState.REQUEST_LLM_SINGLE_EXAMPLE
    : i18nState.REQUEST_LLM_MODEL_EXAMPLE,
)
const examplePlaceholder = computed(() =>
  textInference.backend === 'llamaCPP'
    ? i18nState.COM_LLM_HF_PROMPT_GGUF
    : i18nState.COM_LLM_HF_PROMPT,
)

const isValidModelName = (name: string) =>
  textInference.backend === 'llamaCPP' ? name.split('/').length >= 3 : name.split('/').length === 2

function onShow() {
  animate.value = true
}

async function downloadMmproj(trimmedModelRequest: string) {
  // Construct proper download parameters with all required fields
  const backendName =
    textInference.backend === 'llamaCPP'
      ? 'llama_cpp'
      : textInference.backend === 'openVINO'
        ? 'openvino'
        : 'ollama'
  const modelType = textInference.backend === 'llamaCPP' ? 'ggufLLM' : 'openvinoLLM'

  // Get the model path for this type and backend
  const modelPath = models.getModelPath(modelType, backendName)

  // Save the repo_id - use trimmed value
  const repoId = trimmedModelRequest

  const downloadParams: DownloadModelParam[] = [
    {
      repo_id: repoId,
      type: modelType,
      backend: backendName,
      model_path: modelPath,
    },
  ]

  // Clear input for next addition instead of closing dialog
  modelRequest.value = ''

  try {
    // Check if already loaded (pass params without model_path for the check)
    const checkParams = [
      {
        repo_id: repoId,
        type: modelType,
        backend: backendName as 'llama_cpp' | 'openvino' | 'comfyui',
      },
    ]

    const checked = await models.checkModelAlreadyLoaded(checkParams)
    const isAlreadyLoaded = checked.length > 0 && checked[0].already_loaded

    if (!isAlreadyLoaded) {
      // Queue download dialog (don't await so we can add multiple models)
      const dialogStore = useDialogStore()
      dialogStore.showDownloadDialog(
        downloadParams,
        async () => {
          // After download completes, refresh models to detect the new mmproj file
          await models.refreshModels()
        },
        (error) => {
          console.error('Error downloading mmproj file:', error)
        },
      )
    } else {
      // Already downloaded, just refresh to detect it
      await models.refreshModels()
    }
  } catch (error) {
    console.error('Error downloading mmproj file:', error)
  }
}

async function addModel() {
  const cancelAndShowWarning = (text: string) => {
    addModelErrorMessage.value = text
    addModelError.value = true
  }

  // Trim whitespace from the input
  const trimmedModelRequest = modelRequest.value.trim()

  if (!isValidModelName(trimmedModelRequest)) {
    cancelAndShowWarning('Please provide a valid model reference.')
    return
  }

  const isInModels = models.models.some((model) => model.name === trimmedModelRequest)

  if (isInModels) {
    cancelAndShowWarning(i18nState.ERROR_ALREADY_IN_MODELS)
    return
  }

  const urlExists = await models.checkIfHuggingFaceUrlExists(trimmedModelRequest)
  if (!urlExists) {
    cancelAndShowWarning(i18nState.ERROR_REPO_NOT_EXISTS)
    return
  }

  addModelError.value = false

  // Check if this is an mmproj file (vision helper, not a main model)
  const isMmprojFile = trimmedModelRequest.toLowerCase().includes('mmproj')

  console.log(`[AddLLMDialog] Adding model: ${trimmedModelRequest}, isMmproj: ${isMmprojFile}`)

  if (isMmprojFile) {
    // For mmproj files, directly trigger download without adding to models list
    downloadMmproj(trimmedModelRequest)
    return
  }

  // Regular model addition flow
  const downloadNewModel = async () => {
    try {
      // Add the model to the store and wait for it to be fully processed
      await models.addModel({
        name: trimmedModelRequest,
        type: textInference.backend,
        backend: textInference.backend,
        downloaded: false,
        // For llamaCPP, vision support will be auto-detected when mmproj files are found in the model folder
        supportsVision: undefined,
        // Mark as custom model (not predefined) - will only show in advanced mode
        isPredefined: false,
        // Use sensible defaults for other capabilities (undefined means unknown)
        supportsToolCalling: undefined,
        supportsReasoning: undefined,
        npuSupport: undefined,
        maxContextSize: undefined,
      })

      // Select the newly added model
      textInference.selectModel(textInference.backend, trimmedModelRequest)

      // Wait for reactivity to settle - need two ticks to ensure:
      // 1. selectedModels update triggers llmModels computed recalculation
      // 2. llmModels computed completes and activeModel is updated
      await nextTick()
      await nextTick()

      // Clear input immediately after model is added and selected
      modelRequest.value = ''

      // Check if model needs to be downloaded and show dialog if needed
      // Don't await - we want to allow adding multiple models in sequence
      textInference.checkModelAvailability().catch((error) => {
        console.error('Error checking model availability:', error)
        cancelAndShowWarning(
          `Error: ${error instanceof Error ? error.message : 'Failed to check model availability'}`,
        )
      })
    } catch (error) {
      console.error('Error adding/downloading model:', error)
      cancelAndShowWarning(
        `Error: ${error instanceof Error ? error.message : 'Failed to add model'}`,
      )
    }
  }

  downloadNewModel()
}

function closeAdd() {
  addModelErrorMessage.value = ''
  addModelError.value = false
  modelRequest.value = ''
  emits('close')
}

defineExpose({ onShow })
</script>

<style>
ul {
  list-style-type: disc;
  padding-left: 20px;
}
.hover-box {
  position: absolute;
  background-color: rgba(90, 90, 90, 0.91);
  border: 1px solid #000000;
  padding: 10px;
  border-radius: 10px;
  z-index: 1;
}
</style>
