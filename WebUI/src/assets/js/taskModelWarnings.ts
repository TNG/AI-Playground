import { computed, ref, watch } from 'vue'
import { promptHasImageAttachment } from '@/types/agentIpc'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTaskStep } from '@/types/agentTaskIpc'
import { AGENT_PRESET } from '@/assets/js/store/agentModeSessions'
import { DEV_PRESET_NAMES, dummyWorkflowsOnly } from '@/assets/js/store/devPresets'
import { useErrors } from '@/assets/js/store/errors'
import { useI18N } from '@/assets/js/store/i18n'
import { useModels } from '@/assets/js/store/models'
import { usePresets } from '@/assets/js/store/presets'
import { useTextInference } from '@/assets/js/store/textInference'
import { speechToolModels } from '@/assets/js/speech/speechIO'
import { requestDownload } from '@/assets/js/permissions/permissions'
import { createAppError, extractMessage, isCancellation } from '@/assets/js/errors/appError'
import {
  modelKey,
  modelsToDownload,
  taskModelNeeds,
  taskModelWarnings,
  type ModelRef,
  type TaskModelNeeds,
  type TaskModelWarning,
  type TaskModelWarnings,
} from '@/lib/taskModelNeeds'

const NONE: TaskModelWarnings = { certain: [], maybe: [] }

export type TaskModelWarningsOptions = {
  /** Also check the local chat model, with its projector when one of these Steps has an image. */
  chatModelSteps?: () => readonly AgentTaskStep[] | undefined
}

/**
 * The models a Settings Template may download when its Task runs and which are not on disk,
 * re-checked whenever the template changes. Nothing downloads unless `download` is called.
 */
export function useTaskModelWarnings(
  template: () => AgentSessionSettings | null | undefined,
  options: TaskModelWarningsOptions = {},
) {
  const errors = useErrors()
  const i18n = useI18N()
  const models = useModels()
  const presets = usePresets()
  const textInference = useTextInference()

  const needs = computed<TaskModelNeeds>(() => {
    const settings = template()
    if (!settings) return { certain: [], maybe: [] }
    const { inference } = textInference.inferenceForSettings(AGENT_PRESET, settings)
    const embeddingModel = inference.activeEmbeddingModel
    const steps = options.chatModelSteps?.()
    const chat =
      steps && inference.backend !== 'cloud' && inference.activeModel
        ? textInference.llmModelRefs(
            inference.backend as 'llamaCPP' | 'openVINO',
            inference.activeModel,
            {
              needsVision:
                inference.modelSupportsVision &&
                steps.some((step) => promptHasImageAttachment(step.prompt)),
            },
          )
        : undefined
    return taskModelNeeds({
      template: settings,
      chat,
      embedding: embeddingModel
        ? { backend: inference.embeddingBackend, model: embeddingModel }
        : undefined,
      workflows: dummyWorkflowsOnly()
        ? presets.presets.filter((preset) => DEV_PRESET_NAMES.has(preset.name))
        : presets.presets,
      speech: speechToolModels(),
    })
  })

  const warnings = ref<TaskModelWarnings>(NONE)
  const downloading = ref(false)
  const downloadError = ref('')
  /** The download parameters of the missing models, as the model check returned them. */
  let missing = new Map<string, DownloadModelParam>()
  let generation = 0

  async function refresh(): Promise<void> {
    const current = needs.value
    const run = ++generation
    const refs = modelsToDownload([...current.certain, ...current.maybe])
    if (refs.length === 0) {
      missing = new Map()
      warnings.value = NONE
      return
    }
    try {
      const checked = await models.checkModelAlreadyLoaded(refs)
      if (run !== generation) return
      missing = new Map(
        checked.filter((model) => !model.already_loaded).map((model) => [modelKey(model), model]),
      )
      warnings.value = taskModelWarnings(current, new Set(missing.keys()))
    } catch (error) {
      if (run !== generation) return
      missing = new Map()
      warnings.value = NONE
      errors.report(
        createAppError({
          category: 'backend',
          code: 'agent-tasks/model-check-failed',
          severity: 'warning',
          surface: 'silent',
          userMessage: 'Could not check which models the task needs.',
          technicalMessage: extractMessage(error),
          cause: error,
        }),
      )
    }
  }

  watch(
    () => JSON.stringify(needs.value),
    () => void refresh(),
    { immediate: true },
  )

  /** Ask the user to download the warnings' models; a decline leaves them listed. */
  async function download(list: readonly TaskModelWarning[]): Promise<void> {
    const params = modelsToDownload(list)
      .map((model: ModelRef) => missing.get(modelKey(model)))
      .filter((model): model is DownloadModelParam => model !== undefined)
    if (params.length === 0) return
    downloading.value = true
    downloadError.value = ''
    try {
      await requestDownload(params)
    } catch (error) {
      if (!isCancellation(error)) {
        const technical = extractMessage(error)
        downloadError.value = (
          i18n.state.AGENT_TASK_MODELS_DOWNLOAD_FAILED ?? 'The download failed: {error}'
        ).replace('{error}', technical)
        errors.report(
          createAppError({
            category: 'backend',
            code: 'agent-tasks/model-download-failed',
            severity: 'warning',
            surface: 'inline',
            userMessage: downloadError.value,
            technicalMessage: technical,
            cause: error,
          }),
        )
      }
    } finally {
      downloading.value = false
    }
    await refresh()
  }

  /** How many distinct models the warnings name. */
  const missingCount = computed(
    () => modelsToDownload([...warnings.value.certain, ...warnings.value.maybe]).length,
  )

  return { warnings, missingCount, downloading, downloadError, download }
}

export type TaskModelWarningsState = ReturnType<typeof useTaskModelWarnings>
