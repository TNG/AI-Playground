import { defineStore, acceptHMRUpdate } from 'pinia'
import { WebSocket } from 'partysocket'
import { demoAwareStorage } from '../demoAwareStorage'
import { ComfyUIApiWorkflow, type ComfyInput, type ComfyUiPreset, type Preset } from './presets'
import { ensureDummyWorkflowFixtures } from './devPresets'
import { useDeveloperSettings } from './developerSettings'
import {
  useImageGenerationPresets,
  modelNameForComfyApi,
  OPTIONAL_MODEL_NONE,
  type MediaItem,
} from './imageGenerationPresets'
import { useI18N } from './i18n'
import { useErrors } from './errors'
import { useActivities } from './activities'
import { createAppError } from '../errors/appError'
import { useBackendServices } from '@/assets/js/store/backendServices.ts'
import { usePromptStore } from './promptArea'
import { imageUrlToDataUri, isImageUrl, mediaUrl } from '@/lib/utils'
import { getComfyAuthToken, invalidateComfyAuthToken } from '@/lib/loopbackAuth'
import { startTraceSpan, withTraceSpan, type TraceSpan } from '@/lib/laminarSpans'
import { comfyTraceParameters } from '@/lib/comfyTraceParameters'
import {
  findKeysByClassType,
  findKeysByTitle,
  loaderModelNames,
  modifySettingInWorkflow,
  nodeTitle,
} from './comfyUiWorkflowHelpers'
import {
  ComfyMessageSchema,
  summarizeComfyExecutionError,
  type ComfyExecutionErrorData,
} from './comfyUiMessages'
import {
  bypassNode,
  injectOvmsImageUrl,
  normalizeModelPathsInWorkflow,
  workflowUsesOvmsImage,
} from './comfyUiWorkflowTransforms'

/**
 * Wraps fetch() with the ComfyUI loopback bearer token. The bundled
 * `aipg-auth` ComfyUI custom_node requires this header on every non-/queue
 * request; without it any other local process / web page could reach
 * ComfyUI's API on 127.0.0.1.
 */
async function comfyFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let token = await getComfyAuthToken()
  const buildInit = (t: string): RequestInit => {
    const headers = new Headers(init?.headers ?? {})
    if (t) headers.set('Authorization', `Bearer ${t}`)
    return { ...(init ?? {}), headers }
  }
  let response = await fetch(input, buildInit(token))
  if (response.status === 401) {
    invalidateComfyAuthToken()
    token = await getComfyAuthToken()
    if (token) {
      response = await fetch(input, buildInit(token))
    }
  }
  return response
}

const WEBSOCKET_OPEN = 1

/** Rewire and remove optional model nodes whose value is None (e.g. LoRA bypass). */
function bypassOptionalModelNodes(
  workflow: ComfyUIApiWorkflow,
  inputs: ComfyGenerationInput[],
): void {
  for (const input of inputs) {
    if (
      input.type !== 'model' ||
      input.optional !== true ||
      input.current.value !== OPTIONAL_MODEL_NONE
    ) {
      continue
    }
    const keys = findKeysByTitle(workflow, input.nodeTitle)
    for (const key of keys) {
      bypassNode(workflow, key)
    }
  }
}

import type { InstallationPhase } from './dialogs'

export type InstallationProgressCallback = (progress: {
  phase: InstallationPhase
  currentItem?: string
  completedItems: number
  totalItems: number
  statusMessage: string
}) => void

// ── Explicit generation run ───────────────────────────────────────────────────
//
// One ComfyUI execution, fully described by its caller: which variant-applied
// preset to run, the queued items to fill, the resolved sampling params, and a
// snapshot of the workflow's dynamic inputs. Nothing in here is read off the
// UI's active preset or the imageGeneration form — the artifact runner
// (assets/js/artifact/runArtifact.ts) resolves all of it from an explicit
// request, which is what lets a tool or channel run a workflow without
// touching what the user is looking at.

/** Fully resolved sampling values for one run; the seed is the batch base. */
export type ComfyGenerationParams = {
  prompt: string
  negativePrompt: string
  seed: number
  inferenceSteps: number
  width: number
  height: number
  batchSize: number
}

/** A workflow dynamic input with its resolved current value (plain ref, not store-bound). */
export type ComfyGenerationInput = ComfyInput & { current: Ref<unknown> }

export type ComfyGenerationRun = {
  preset: ComfyUiPreset
  /** Queued items, one per batch entry; the websocket fills them in place. */
  items: MediaItem[]
  params: ComfyGenerationParams
  inputs: ComfyGenerationInput[]
  sourceImage?: string
}

export const useComfyUiPresets = defineStore(
  'comfyUiPresets',
  () => {
    const imageGeneration = useImageGenerationPresets()
    const errors = useErrors()
    const activities = useActivities()
    const developerSettings = useDeveloperSettings()
    const i18nState = useI18N().state
    const comfyPort = computed(() => comfyUiState.value?.port)

    // Bridge the generation FSM (imageGeneration.currentState) to a single activity
    // so the central activity sink reflects image-gen progress. For desktop runs the
    // activity is imageGen-scoped; for tool calls it nests under the chat tool
    // activity (generationParentActivityId) so the chat status line shows progress.
    let generationActivityId: string | null = null
    const GENERATION_ACTIVE_STATES = [
      'start_backend',
      'install_workflow_components',
      'load_workflow_components',
      'load_model',
      'load_model_components',
      'generating',
    ]
    function generationStateLabel(state: string): string {
      switch (state) {
        case 'start_backend':
          return i18nState.COM_STARTING_BACKEND
        case 'load_model':
          return i18nState.COM_LOADING_MODEL
        case 'load_model_components':
          return i18nState.COM_LOADING_MODEL_COMPONENTS
        case 'install_workflow_components':
          return i18nState.COM_INSTALL_WORKFLOW_COMPONENTS
        case 'load_workflow_components':
          return i18nState.COM_LOADING_WORKFLOW_COMPONENTS
        case 'generating':
          return imageGeneration.stepText || i18nState.COM_GENERATING
        default:
          return i18nState.COM_GENERATING
      }
    }
    // Laminar spans for the same lifecycle (dev-only; no-ops unless a developer
    // configured tracing). `comfyui.generate` opens with the run and closes when
    // the FSM settles — which is after generate() has returned, since the
    // websocket drives everything from the queued prompt onwards. The phases
    // below are its children, one span per FSM state rather than one per
    // websocket tick.
    let generateSpan: TraceSpan | null = null
    let phaseSpan: TraceSpan | null = null
    const GENERATING_SPAN = 'comfyui.generating'
    const PHASE_SPANS: Record<string, string | undefined> = {
      load_workflow_components: 'comfyui.load_workflow_components',
      load_model: 'comfyui.load_model',
      load_model_components: 'comfyui.load_model',
      generating: GENERATING_SPAN,
    }

    /** Which loader node a `comfyui.load_model` span is about, and what it loads. */
    type LoaderDetail = { node: string; title?: string; model?: string }
    let phaseDetail: string | null = null

    function enterPhaseSpan(state: string, detail?: LoaderDetail) {
      const name = PHASE_SPANS[state]
      // Detail is part of the identity: a workflow that loads a unet and then a
      // clip stays in `load_model` throughout, and one span covering both says
      // nothing about which of them was slow.
      if (phaseSpan?.name === name && phaseDetail === (detail?.node ?? null)) return
      phaseSpan?.end()
      phaseDetail = detail?.node ?? null
      if (!name) {
        phaseSpan = null
        return
      }
      phaseSpan = startTraceSpan(name, {
        parentId: generateSpan?.id,
        attributes: detail && {
          'aipg.node': detail.title ?? detail.node,
          'aipg.model': detail.model,
        },
      })
      if (name === GENERATING_SPAN) phaseSpan.setAttributes({ 'aipg.queued': queuedImages.length })
    }

    function endGenerationSpans(state: 'done' | 'failed' | 'cancelled') {
      phaseSpan?.end()
      phaseSpan = null
      phaseDetail = null
      generateSpan?.setAttributes({ 'aipg.items_done': generateIdx })
      generateSpan?.end(
        state === 'failed'
          ? { error: imageGeneration.lastError ?? 'generation failed' }
          : undefined,
      )
      generateSpan = null
    }

    /** Latest websocket progress, on the generating span rather than a span each. */
    function noteGenerationProgress(value: number, max: number) {
      if (phaseSpan?.name !== GENERATING_SPAN) return
      phaseSpan.setAttributes({ 'aipg.progress_step': value, 'aipg.progress_total': max })
    }

    watch(
      () =>
        [
          imageGeneration.currentState,
          imageGeneration.stepText,
          imageGeneration.processing,
        ] as const,
      ([state, _stepText, processing]) => {
        const isActive = processing || GENERATION_ACTIVE_STATES.includes(state)
        if (isActive) {
          const label = generationStateLabel(state)
          if (!generationActivityId) {
            generationActivityId = activities.begin({
              category: 'generation',
              label,
              scope: { kind: 'imageGen' },
              parentId: imageGeneration.generationParentActivityId ?? undefined,
            })
          } else {
            activities.update(generationActivityId, { label })
          }
          enterPhaseSpan(state, state.startsWith('load_model') ? loadingNode : undefined)
        } else if (generationActivityId || generateSpan) {
          const endState =
            state === 'error' ? 'failed' : state === 'image_out' ? 'done' : 'cancelled'
          if (generationActivityId) {
            activities.end(generationActivityId, endState)
            generationActivityId = null
          }
          endGenerationSpans(endState)
        }
      },
    )

    // Set while we intentionally restart ComfyUI mid-generate (to install custom
    // nodes), so crash detection doesn't mistake the planned bounce for a crash.
    let backendRestarting = false

    // Stall protection lives in the artifact runner (runArtifact.ts), which
    // every driver goes through: one re-arming idle watchdog covering the
    // backend boot / install / model-load phases as well as execution. This
    // store no longer arms its own execution-only timer.
    const comfyBaseUrl = computed(() => comfyUiState.value?.baseUrl)

    const websocket = ref<WebSocket | null>(null)
    const clientId = '12345'
    const loaderNodes = ref<string[]>([])
    /** Model file per loader node, for the span that covers its load. */
    let loaderModels: Record<string, LoaderDetail> = {}
    /** The loader the backend is on. The FSM state does not change between two. */
    let loadingNode: LoaderDetail | undefined
    let generateIdx: number = 0
    let queuedImages: MediaItem[] = []

    // shallowRef: the run carries live plain refs in its inputs (the settings
    // snapshot the artifact runner owns); a deep ref would unwrap them and a
    // queued retry would read `current.value` off a raw value.
    const pendingGenerationRequest = shallowRef<{ run: ComfyGenerationRun } | null>(null)
    const pendingRetryTimer = ref<ReturnType<typeof setTimeout> | null>(null)

    const backendServices = useBackendServices()
    const comfyUiState = computed(() => {
      return backendServices.info.find((item) => item.serviceName === 'comfyui-backend')
    })

    async function installCustomNodesForPresetFully(preset: Preset) {
      const requirements = await checkPresetRequirements(preset)
      // Traced from here on, so a generate that had nothing to install carries no
      // install span at all — its absence is the interesting part.
      if (!requirements.hasMissingRequirements) return
      await withTraceSpan(
        'comfyui.install_nodes',
        async () => {
          console.info('restarting comfyUI to finalize installation of required custom nodes')
          // Suspend crash detection: this stop/start is intentional, not a crash.
          backendRestarting = true
          try {
            await backendServices.stopService('comfyui-backend')
            await triggerInstallPythonPackagesForPreset(preset) // Backend already stopped above
            await installCustomNodesForPreset(preset)
            const startingResult = await backendServices.startService('comfyui-backend')
            if (startingResult !== 'running') {
              throw new Error('Failed to restart comfyUI. Required Nodes are not active.')
            }
            console.info('restart complete')
          } finally {
            backendRestarting = false
          }
        },
        {
          parentId: generateSpan?.id,
          attributes: {
            'aipg.custom_nodes': requirements.missingCustomNodes.join(', ') || undefined,
            'aipg.python_packages': requirements.missingPythonPackages.join(', ') || undefined,
          },
        },
      )
    }

    async function checkPresetRequirements(preset: Preset | null): Promise<{
      hasMissingRequirements: boolean
      missingCustomNodes: string[]
      missingPythonPackages: string[]
    }> {
      if (!preset || preset.type !== 'comfy') {
        return {
          hasMissingRequirements: false,
          missingCustomNodes: [],
          missingPythonPackages: [],
        }
      }

      const customNodes = preset.requiredCustomNodes ?? []
      const pythonPackages = preset.requiredPythonPackages ?? []

      console.info('Checking preset requirements', {
        customNodes,
        pythonPackages,
      })

      const nodeChecks = await Promise.all(
        customNodes.map(async (node) => {
          const isInstalled = await window.electronAPI.comfyui.isCustomNodeInstalled(
            extractCustomNodeInfo(node),
          )
          return { node, isInstalled }
        }),
      )
      const missingCustomNodes = nodeChecks
        .filter((check) => !check.isInstalled)
        .map((check) => check.node)

      const packageChecks = await Promise.all(
        pythonPackages.map(async (pkg) => {
          const isInstalled = await window.electronAPI.comfyui.isPackageInstalled(pkg)
          return { package: pkg, isInstalled }
        }),
      )
      const missingPythonPackages = packageChecks
        .filter((check) => !check.isInstalled)
        .map((check) => check.package)

      const hasMissingRequirements =
        missingCustomNodes.length > 0 || missingPythonPackages.length > 0

      return {
        hasMissingRequirements,
        missingCustomNodes,
        missingPythonPackages,
      }
    }

    function extractCustomNodeInfo(
      workflowNodeInfoString: string,
    ): ComfyUICustomNodesRequestParameters {
      const repoInfoWithPotentialGitRefSplitted = workflowNodeInfoString.replace(' ', '').split('@')
      if (
        repoInfoWithPotentialGitRefSplitted.length > 2 ||
        repoInfoWithPotentialGitRefSplitted.length < 1
      ) {
        console.error(`Could not extract comfyUI node description from ${workflowNodeInfoString}`)
        throw new Error('Could not extract comfyUI node description from ${workflowNodeInfoString}')
      }
      const [repoInfoString, gitRef] = repoInfoWithPotentialGitRefSplitted
      if (!gitRef) {
        console.warn(`No gitRef provided in ${workflowNodeInfoString}.`)
      }
      const repoInfoSplitted = repoInfoString.replace(' ', '').split('/')
      if (repoInfoSplitted.length !== 2) {
        console.error(`Could not extract comfyUI node description from ${workflowNodeInfoString}`)
        throw new Error('Could not extract comfyUI node description from ${workflowNodeInfoString}')
      }
      const [username, repoName] = repoInfoSplitted
      return { username: username, repoName: repoName, gitRef: gitRef }
    }

    async function installCustomNodesForPreset(
      preset: Preset,
      callback?: InstallationProgressCallback,
    ): Promise<boolean> {
      if (preset.type !== 'comfy') return false

      const requiredCustomNodes = preset.requiredCustomNodes ?? []

      const nodesToInstall: ComfyUICustomNodesRequestParameters[] = []
      for (const node of requiredCustomNodes) {
        const isInstalled = await window.electronAPI.comfyui.isCustomNodeInstalled(
          extractCustomNodeInfo(node),
        )
        if (!isInstalled) {
          nodesToInstall.push(extractCustomNodeInfo(node))
        }
      }

      if (nodesToInstall.length === 0) return false

      try {
        for (let i = 0; i < nodesToInstall.length; i++) {
          const node = nodesToInstall[i]
          const nodeName = `${node.username}/${node.repoName}`
          callback?.({
            phase: 'installing_custom_nodes',
            currentItem: nodeName,
            completedItems: i,
            totalItems: nodesToInstall.length,
            statusMessage: `Installing custom node: ${nodeName}`,
          })
          const result = await window.electronAPI.comfyui.downloadCustomNode(node)
          if (!result) {
            throw new Error(`Failed to install custom node: ${nodeName}`)
          }
          callback?.({
            phase: 'installing_custom_nodes',
            currentItem: nodeName,
            completedItems: i + 1,
            totalItems: nodesToInstall.length,
            statusMessage: `Installed custom node: ${nodeName}`,
          })
        }
        return true
      } catch (_error) {
        const failedNodeNames = nodesToInstall.map((n) => `${n.username}/${n.repoName}`).join(', ')
        throw new Error(`Failed to install required comfyUI custom nodes: ${failedNodeNames}`)
      }
    }

    async function triggerInstallPythonPackagesForPreset(
      preset: Preset,
      callback?: InstallationProgressCallback,
    ) {
      if (preset.type !== 'comfy') return

      const toBeInstalledPackages = preset.requiredPythonPackages ?? []
      console.info('Installing python packages', { toBeInstalledPackages })

      if (toBeInstalledPackages.length === 0) return

      // Note: Backend should already be stopped by installMissingRequirements if needed

      try {
        for (let i = 0; i < toBeInstalledPackages.length; i++) {
          const pkg = toBeInstalledPackages[i]
          callback?.({
            phase: 'installing_python_packages',
            currentItem: pkg,
            completedItems: i,
            totalItems: toBeInstalledPackages.length,
            statusMessage: `Installing Python package: ${pkg}`,
          })
          await window.electronAPI.comfyui.installPypiPackage(pkg)
          callback?.({
            phase: 'installing_python_packages',
            currentItem: pkg,
            completedItems: i + 1,
            totalItems: toBeInstalledPackages.length,
            statusMessage: `Installed Python package: ${pkg}`,
          })
        }
        console.info('python package installation completed')
      } catch (error) {
        throw new Error(`Failed to install Python packages: ${error}`)
      }
    }

    /**
     * Installs missing requirements for a preset (custom nodes and Python packages)
     * This will restart the ComfyUI backend if needed
     */
    async function installMissingRequirements(
      preset: Preset,
      callback?: InstallationProgressCallback,
    ): Promise<void> {
      if (preset.type !== 'comfy') {
        throw new Error('No ComfyUI preset is active')
      }

      // Check what's missing
      const requirements = await checkPresetRequirements(preset)

      if (!requirements.hasMissingRequirements) {
        console.info('No missing requirements to install')
        return
      }

      // Stop backend before installation
      const wasRunning =
        backendServices.info.find((s) => s.serviceName === 'comfyui-backend')?.status === 'running'

      if (wasRunning) {
        callback?.({
          phase: 'stopping_backend',
          completedItems: 0,
          totalItems: 0,
          statusMessage: 'Stopping ComfyUI backend...',
        })
        await backendServices.stopService('comfyui-backend')
        callback?.({
          phase: 'stopping_backend',
          completedItems: 1,
          totalItems: 1,
          statusMessage: 'ComfyUI backend stopped',
        })
      }

      try {
        // Install Python packages first (if any)
        if (requirements.missingPythonPackages.length > 0) {
          console.info('Installing Python packages:', requirements.missingPythonPackages)
          await triggerInstallPythonPackagesForPreset(preset, callback)
        }

        // Install custom nodes (if any)
        if (requirements.missingCustomNodes.length > 0) {
          console.info('Installing custom nodes:', requirements.missingCustomNodes)
          await installCustomNodesForPreset(preset, callback)
        }

        // Restart backend if it was running
        if (wasRunning) {
          callback?.({
            phase: 'starting_backend',
            completedItems: 0,
            totalItems: 0,
            statusMessage: 'Starting ComfyUI backend...',
          })
          const startResult = await backendServices.startService('comfyui-backend')
          if (startResult !== 'running') {
            throw new Error('Failed to restart ComfyUI backend after installation')
          }
          callback?.({
            phase: 'starting_backend',
            completedItems: 1,
            totalItems: 1,
            statusMessage: 'ComfyUI backend started',
          })
        }
      } catch (error) {
        console.error('Error installing missing requirements:', error)
        callback?.({
          phase: 'error',
          completedItems: 0,
          totalItems: 0,
          statusMessage: `Installation failed: ${error instanceof Error ? error.message : String(error)}`,
        })
        throw error
      }
    }

    async function connectToComfyUi() {
      if (comfyUiState.value?.status !== 'running') {
        console.warn('ComfyUI backend not running, cannot start websocket')
        return
      }

      // Browsers cannot set custom headers on WebSocket upgrades, so the
      // bundled aipg-auth middleware accepts the loopback token via query
      // string for the /ws endpoint.
      //
      // Force-refresh the token: a rejected WS upgrade just shows up as a
      // close event with no auth-specific status code, so we can't detect
      // and retry like we do for HTTP 401. Pulling fresh from the Electron
      // main process on every connect attempt is cheap (single IPC) and
      // ensures we never connect with a token from a previous ComfyUI spawn
      // (each spawn regenerates AIPG_LOOPBACK_TOKEN).
      const wsToken = await getComfyAuthToken(true)
      const comfyWsUrl =
        `ws://localhost:${comfyPort.value}/ws?clientId=${clientId}` +
        (wsToken ? `&token=${encodeURIComponent(wsToken)}` : '')

      if (websocket.value) {
        const state = websocket.value.readyState
        if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) {
          console.info('ComfyUI websocket already connected or connecting, reusing')
          return
        }
        console.info('Closing stale websocket connection before creating new one')
        try {
          websocket.value.close()
        } catch (e) {
          console.warn('Error closing stale websocket:', e)
        }
        websocket.value = null
      }

      console.info('Connecting to ComfyUI', { comfyWsUrl })
      websocket.value = new WebSocket(comfyWsUrl)
      websocket.value.binaryType = 'arraybuffer'

      websocket.value.addEventListener('open', () => {
        console.info('ComfyUI websocket connection established')
      })

      websocket.value.addEventListener('close', (event) => {
        console.info('ComfyUI websocket connection closed', {
          code: event.code,
          reason: event.reason,
        })
        // Drop the cached token in case the close was caused by an auth
        // rejection on the upgrade (e.g. ComfyUI restarted with a fresh
        // AIPG_LOOPBACK_TOKEN). The next connect attempt will pull a fresh
        // token from the Electron main process. This is also a no-op on a
        // clean close, since the next force-refresh in connectToComfyUi
        // will overwrite it anyway.
        invalidateComfyAuthToken()
      })

      websocket.value.addEventListener('error', (error) => {
        console.error('ComfyUI websocket error:', error)
      })

      websocket.value.addEventListener('message', (event) => {
        try {
          if (event.data instanceof ArrayBuffer) {
            const view = new DataView(event.data)
            const eventType = view.getUint32(0)
            const buffer = event.data.slice(4)
            switch (eventType) {
              case 1:
                // Always update the image state to 'generating' for progress display
                const currentImage = queuedImages[generateIdx]
                if (currentImage && currentImage.state !== 'generating') {
                  imageGeneration.updateImage({
                    ...currentImage,
                    state: 'generating',
                  })
                }

                // Skip preview image if showPreview is disabled
                if (!imageGeneration.showPreview) break

                const view2 = new DataView(event.data)
                const imageType = view2.getUint32(0)
                let imageMime
                switch (imageType) {
                  case 1:
                  default:
                    imageMime = 'image/jpeg'
                    break
                  case 2:
                    imageMime = 'image/png'
                }
                const imageBlob = new Blob([buffer.slice(4)], {
                  type: imageMime,
                })
                const imageUrl = URL.createObjectURL(imageBlob)
                if (imageBlob) {
                  const newImage: MediaItem = {
                    ...queuedImages[generateIdx],
                    state: 'generating',
                    type: 'image',
                    imageUrl,
                  }
                  imageGeneration.updateImage(newImage)
                }
                break
              case 3:
                // TEXT: a node progress string. Unused; JSON `progress` already drives the UI.
                break
              default:
                // 2 UNENCODED_PREVIEW_IMAGE, 4 PREVIEW_IMAGE_WITH_METADATA, and future types.
                break
            }
          } else {
            const msg = ComfyMessageSchema.parse(JSON.parse(event.data))
            switch (msg.type) {
              case 'status':
                break
              case 'progress':
                imageGeneration.currentState = 'generating'
                imageGeneration.stepText = `${i18nState.COM_GENERATING} ${msg.data.value}/${msg.data.max}`
                if (generationActivityId && msg.data.max > 0) {
                  activities.update(generationActivityId, {
                    label: imageGeneration.stepText,
                    progress: msg.data.value / msg.data.max,
                  })
                }
                noteGenerationProgress(msg.data.value, msg.data.max)
                console.log('progress', { data: msg.data })
                break
              case 'executing':
                const executingNode = msg.data.node
                console.log('executing', {
                  detail: msg.data.display_node || executingNode,
                  node: executingNode,
                  isLoaderNode: loaderNodes.value.includes(executingNode ?? ''),
                })
                // Transition state based on which node is executing
                if (executingNode && loaderNodes.value.includes(executingNode)) {
                  loadingNode = loaderModels[executingNode] ?? { node: executingNode }
                  // Driven from here, not from the state watch: a second loader
                  // leaves the FSM state untouched, so the watch never fires.
                  enterPhaseSpan('load_model', loadingNode)
                  imageGeneration.currentState = 'load_model'
                } else if (executingNode === null) {
                  // Node is null when execution starts/ends - keep current state or transition to generating
                  if (imageGeneration.currentState === 'load_workflow_components') {
                    imageGeneration.currentState = 'generating'
                  }
                } else {
                  // Regular node execution - transition to generating
                  imageGeneration.currentState = 'generating'
                }
                break
              case 'executed':
                const output = msg.data.output
                const createdAt = Date.now()
                if ('images' in output) {
                  const imageIndex = output.images.findIndex((i) => i.type === 'output')
                  const image = output.images[imageIndex]
                  if (image) {
                    let newItem: MediaItem
                    if (output?.animated?.[imageIndex]) {
                      const videoUrl = mediaUrl(
                        image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename,
                      )
                      newItem = {
                        ...queuedImages[generateIdx],
                        state: 'done',
                        type: 'video',
                        videoUrl,
                        createdAt,
                      }
                    } else {
                      newItem = {
                        ...queuedImages[generateIdx],
                        state: 'done',
                        type: 'image',
                        imageUrl: mediaUrl(
                          image.subfolder ? `${image.subfolder}/${image.filename}` : image.filename,
                        ),
                        createdAt,
                      }
                    }
                    imageGeneration.updateImage(newItem)
                    generateIdx++
                    // Update state when image is received
                    if (generateIdx >= queuedImages.length) {
                      imageGeneration.currentState = 'image_out'
                    }
                  }
                }
                if ('gifs' in output) {
                  const video = output.gifs.find((i) => i.type === 'output')
                  if (video) {
                    const videoUrl = mediaUrl(
                      video.subfolder ? `${video.subfolder}/${video.filename}` : video.filename,
                    )
                    const thumbnailUrl = mediaUrl(
                      video.subfolder ? `${video.subfolder}/${video.workflow}` : video.workflow,
                    )
                    const newImage: MediaItem = {
                      ...queuedImages[generateIdx],
                      state: 'done',
                      type: 'video',
                      videoUrl,
                      thumbnailUrl,
                      createdAt,
                    }
                    imageGeneration.updateImage(newImage)
                    generateIdx++
                    // Update state when video is received
                    if (generateIdx >= queuedImages.length) {
                      imageGeneration.currentState = 'image_out'
                    }
                  }
                }
                if ('3d' in output) {
                  const model3d = output['3d'].find((i) => i.type === 'output')
                  if (model3d) {
                    const model3dUrl = mediaUrl(
                      model3d.subfolder
                        ? `${model3d.subfolder}/${model3d.filename}`
                        : model3d.filename,
                    )
                    const newImage: MediaItem = {
                      ...queuedImages[generateIdx],
                      state: 'done',
                      type: 'model3d',
                      model3dUrl,
                      createdAt,
                    }
                    imageGeneration.updateImage(newImage)
                    generateIdx++
                    // Update state when 3D model is received
                    if (generateIdx >= queuedImages.length) {
                      imageGeneration.currentState = 'image_out'
                    }
                  }
                }
                console.log('executed', { detail: msg.data })
                break
              case 'execution_start': {
                // Ignore stray starts for batch entries we already failed/cancelled,
                // so the UI doesn't bounce back into 'processing' with nothing in flight.
                const hasInFlight = imageGeneration.generatedImages.some(
                  (item) => item.state === 'queued' || item.state === 'generating',
                )
                if (!hasInFlight) {
                  console.log('execution_start ignored (no in-flight items)', { detail: msg.data })
                  break
                }
                imageGeneration.processing = true
                imageGeneration.currentState = 'load_workflow_components'
                console.log('execution_start', { detail: msg.data })
                break
              }
              case 'execution_success':
                imageGeneration.processing = false
                console.log('execution_success', { detail: msg.data })
                break
              case 'execution_error': {
                const promptStore = usePromptStore()
                promptStore.promptSubmitted = false
                const data = msg.data as ComfyExecutionErrorData
                // Short, actionable message for the failed panel + toast; the raw
                // exception/traceback is kept only in technicalMessage (console + debug).
                const userMessage = summarizeComfyExecutionError(data)
                const technicalMessage =
                  [
                    data.exception_type,
                    data.node_type ? `node: ${data.node_type} (${data.node_id ?? '?'})` : null,
                    data.exception_message,
                    Array.isArray(data.traceback) ? data.traceback.join('') : null,
                  ]
                    .filter(Boolean)
                    .join('\n') || JSON.stringify(msg.data)
                // Move in-flight items to a terminal 'failed' state (no more stuck
                // spinners) and surface a single toast via the sink.
                imageGeneration.failGeneration(userMessage)
                errors.report(
                  createAppError({
                    category: 'generation',
                    code: 'generation/execution-error',
                    userMessage,
                    technicalMessage,
                    surface: 'toast',
                    context: { serviceName: 'comfyui-backend' },
                  }),
                )
                break
              }
              case 'execution_interrupted':
                imageGeneration.processing = false
                imageGeneration.currentState = 'no_start'
                break
              case 'execution_cached':
                break
              case 'progress_state':
                break
            }
          }
        } catch (error) {
          console.warn('Unhandled message:', event.data, error)
        }
      })
    }

    watchEffect(() => {
      const isRunning = comfyPort.value != null && comfyUiState.value?.status === 'running'

      if (isRunning) {
        connectToComfyUi()

        if (pendingGenerationRequest.value) {
          console.info('Backend is now running, auto-retrying pending generation')
          const pending = pendingGenerationRequest.value

          if (pendingRetryTimer.value !== null) {
            clearTimeout(pendingRetryTimer.value)
            pendingRetryTimer.value = null
          }

          const attemptRetry = () => {
            pendingRetryTimer.value = setTimeout(() => {
              pendingRetryTimer.value = null
              if (websocket.value?.readyState !== WEBSOCKET_OPEN) {
                console.info('Websocket not yet open, re-scheduling pending generation retry')
                attemptRetry()
                return
              }
              pendingGenerationRequest.value = null
              generate(pending.run, true)
            }, 500)
          }
          attemptRetry()
        }
      } else {
        if (pendingRetryTimer.value !== null) {
          clearTimeout(pendingRetryTimer.value)
          pendingRetryTimer.value = null
        }
        if (websocket.value) {
          console.info('Backend is not running, closing websocket connection')
          try {
            websocket.value.close()
          } catch (e) {
            console.warn('Error closing websocket:', e)
          }
          websocket.value = null
        }
      }
    })

    // Crash detection: if the backend leaves 'running' while a generation is in
    // flight (and we didn't intentionally restart it for a node install), the
    // process has died/stopped underneath us. Fail the in-flight items instead of
    // letting the UI sit on a stale 'running' world with a frozen spinner.
    watch(
      () => comfyUiState.value?.status,
      (status, previousStatus) => {
        if (previousStatus === 'running' && status !== 'running') {
          if (backendRestarting) return
          if (!imageGeneration.processing && imageGeneration.currentState === 'no_start') return
          const promptStore = usePromptStore()
          promptStore.promptSubmitted = false
          imageGeneration.failGeneration('The ComfyUI backend stopped unexpectedly.')
          errors.report(
            createAppError({
              category: 'generation',
              code: 'generation/backend-stopped',
              userMessage:
                'The ComfyUI backend stopped unexpectedly during generation. Please restart it and try again.',
              surface: 'toast',
              context: { serviceName: 'comfyui-backend' },
            }),
          )
        }
      },
    )

    function dataURItoBlob(dataURI: string) {
      const bytes =
        dataURI.split(',')[0].indexOf('base64') >= 0
          ? atob(dataURI.split(',')[1])
          : unescape(dataURI.split(',')[1])
      const mimeType = dataURI.split(',')[0].split(':')[1].split(';')[0]

      const intArray = new Uint8Array(bytes.length)
      for (let i = 0; i < bytes.length; i++) {
        intArray[i] = bytes.charCodeAt(i)
      }

      return new Blob([intArray], { type: mimeType })
    }

    // ComfyUI v0.25.1's LoadImage decodes every image through PyAV. Frames that
    // decode to a non-rgb24/rgba pixel format (16-bit or grayscale PNGs, incl.
    // the 1-bit grayscale placeholder used for empty optional inputs) take a
    // pad/fillborders alignment filter graph when their width isn't a multiple
    // of 32, which fails format negotiation on the bundled ffmpeg
    // (av.error.ArgumentError: Invalid argument returned 22). Re-encoding the
    // image through a 2D canvas forces 8-bit RGBA, so it decodes to rgb24/rgba
    // and skips that branch entirely.
    async function reencodeImageTo8BitPng(dataUri: string): Promise<string> {
      const img = new Image()
      img.src = dataUri
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve()
        img.onerror = () => reject(new Error('Failed to load image for re-encoding'))
      })
      if (img.naturalWidth === 0 || img.naturalHeight === 0) return dataUri
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return dataUri
      ctx.drawImage(img, 0, 0)
      return canvas.toDataURL('image/png')
    }

    function validateRequiredImageInputs(inputs: ComfyGenerationInput[]): string[] {
      const missingInputs: string[] = []

      for (const input of inputs) {
        // Skip optional image inputs - they will get black pixel injected
        if (input.optional === true) {
          continue
        }

        // Check if this is a required image input
        const isImageType =
          input.type === 'image' || input.type === 'inpaintMask' || input.type === 'outpaintCanvas'
        const isDisplayed = input.displayed !== false // defaults to true
        const isModifiable = input.modifiable !== false // defaults to true
        const hasNoDefault = input.defaultValue === '' || input.defaultValue === undefined

        if (isImageType && isDisplayed && isModifiable && hasNoDefault) {
          const value = input.current.value
          const isEmpty = value === '' || value === undefined || value === null
          const isString = typeof value === 'string'
          const isValid = isString && value !== '' && isImageUrl(value)

          if (isEmpty || !isValid) {
            missingInputs.push(input.label)
          }
        }
      }

      return missingInputs
    }

    async function modifyDynamicSettingsInWorkflow(
      mutableWorkflow: ComfyUIApiWorkflow,
      platform: NodeJS.Platform,
      inputs: ComfyGenerationInput[],
    ) {
      for (const input of inputs) {
        const keys = findKeysByTitle(mutableWorkflow, input.nodeTitle)
        if (keys.length === 0) {
          continue
        }
        if (
          input.type === 'number' ||
          input.type === 'string' ||
          input.type === 'boolean' ||
          input.type === 'stringList'
        ) {
          if (mutableWorkflow[keys[0]].inputs !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = input.current.value
          }
        }
        if (input.type === 'model') {
          if (input.current.value === OPTIONAL_MODEL_NONE) {
            // Node will be bypassed by bypassOptionalModelNodes; do not set value
            continue
          }
          if (mutableWorkflow[keys[0]].inputs !== undefined) {
            const value =
              typeof input.current.value === 'string'
                ? modelNameForComfyApi(input.current.value, platform)
                : input.current.value
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = value
          }
        }
        if (
          input.type === 'image' ||
          input.type === 'inpaintMask' ||
          input.type === 'outpaintCanvas'
        ) {
          const rawValue = input.current.value
          const isEmpty = typeof rawValue !== 'string' || rawValue === '' || !isImageUrl(rawValue)
          const isOptional = input.optional === true

          let imageDataUri: string
          if (isEmpty && isOptional && input.type === 'image') {
            imageDataUri =
              'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
          } else if (typeof rawValue === 'string' && rawValue !== '') {
            imageDataUri = rawValue.startsWith('aipg-media://')
              ? await imageUrlToDataUri(rawValue)
              : rawValue
          } else {
            continue
          }

          // Normalize to 8-bit RGBA PNG so ComfyUI's PyAV-based LoadImage never
          // hits the alignment filter graph that crashes on planar-float /
          // grayscale frames (see reencodeImageTo8BitPng).
          imageDataUri = await reencodeImageTo8BitPng(imageDataUri)

          const uploadImageHash = Array.from(
            new Uint8Array(
              await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(imageDataUri)),
            ),
          )
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          // Always PNG now that the data URI is canvas-re-encoded above.
          const uploadImageName = `${uploadImageHash}.png`
          if (mutableWorkflow[keys[0]].inputs !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = uploadImageName
          }
          const data = new FormData()
          data.append('image', dataURItoBlob(imageDataUri), uploadImageName)
          await comfyFetch(`${comfyBaseUrl.value}/upload/image`, {
            method: 'POST',
            body: data,
          })
        }
        if (input.type === 'video') {
          if (typeof input.current.value !== 'string') continue
          const uploadVideoHash = Array.from(
            new Uint8Array(
              await window.crypto.subtle.digest(
                'SHA-256',
                new TextEncoder().encode(input.current.value),
              ),
            ),
          )
            .map((b) => b.toString(16).padStart(2, '0'))
            .join('')
          const uploadVideoExtension = input.current.value.match(
            /data:video\/(mp4|h264|h265);base64,/,
          )?.[1]
          const uploadVideoName = `${uploadVideoHash}.${uploadVideoExtension}`
          if (mutableWorkflow[keys[0]].inputs !== undefined) {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ;(mutableWorkflow[keys[0]].inputs as any)[input.nodeInput] = uploadVideoName
          }
          const data = new FormData()
          data.append('image', dataURItoBlob(input.current.value), uploadVideoName)
          await comfyFetch(`${comfyBaseUrl.value}/upload/image`, {
            method: 'POST',
            body: data,
          })
        }
      }
    }

    // Helper function to reset UI state on error
    function resetGenerationState() {
      imageGeneration.processing = false
      imageGeneration.currentState = 'no_start'
      const promptStore = usePromptStore()
      promptStore.promptSubmitted = false
    }

    /**
     * If the preset's workflow uses OVMS image nodes, ensure the OVMS image server
     * is running with the correct model. Returns the server URL on success, null if
     * the workflow doesn't need OVMS, or false on failure (caller should abort).
     */
    async function ensureOvmsImageServerIfNeeded(
      preset: Preset,
      inputs: ComfyGenerationInput[],
      params: ComfyGenerationParams,
    ): Promise<string | null | false> {
      if (preset.type !== 'comfy') return null
      if (!workflowUsesOvmsImage(preset.comfyUiApiWorkflow)) return null

      const modelInput = inputs.find((input) => 'nodeInput' in input && input.nodeInput === 'model')
      const modelId =
        (modelInput && 'current' in modelInput ? String(modelInput.current.value) : '') ||
        preset.requiredModels?.[0]?.model ||
        ''

      if (!modelId) {
        errors.report(
          createAppError({
            category: 'generation',
            code: 'generation/ovms-no-model',
            userMessage: 'No model id configured for OVMS image generation.',
            surface: 'toast',
          }),
        )
        return false
      }

      try {
        const { keepModelsLoaded } = developerSettings
        // Pass the current generation resolution so OVMS can statically reshape the image
        // pipeline when running on NPU (required by the NPU plugin). Ignored on other devices.
        const resolution = `${params.width}x${params.height}`
        const result = await window.electronAPI.ensureOvmsImageReady(
          'openvino-backend',
          modelId,
          keepModelsLoaded,
          resolution,
        )
        if (result.success && result.url) {
          return result.url
        }
        errors.report(
          createAppError({
            category: 'generation',
            code: 'generation/ovms-start-failed',
            userMessage: `Failed to start OVMS image server: ${result.error || 'unknown error'}`,
            surface: 'toast',
            context: { serviceName: 'openvino-backend' },
          }),
        )
        return false
      } catch (error) {
        errors.report(error, {
          category: 'generation',
          code: 'generation/ovms-error',
          userMessage: 'OVMS image server error.',
          surface: 'toast',
          context: { serviceName: 'openvino-backend' },
        })
        return false
      }
    }

    /**
     * Submit one fully resolved generation run: start the backend if needed
     * (queueing for an auto-retry while it boots), install the preset's
     * missing workflow components, then POST the rewritten workflow once per
     * batch item. Resolves as soon as the prompts are queued — the websocket
     * drives the phase transitions from there. Returns false when the run was
     * refused (a generation is already in flight), so callers can fail fast
     * instead of watching items that will never move.
     */
    async function generate(run: ComfyGenerationRun, isRetry = false): Promise<boolean> {
      const preset = run.preset
      if (preset.type !== 'comfy') {
        console.warn('The selected preset is not a comfyui preset')
        return false
      }
      // `isRetry` is the auto-retry that fires once the backend finishes starting.
      // It is a continuation of the same operation, so it must bypass the
      // re-entrancy guard (which still keeps `processing` true to drive the UI).
      if (imageGeneration.processing && !isRetry) {
        console.warn('Already processing')
        return false
      }

      // The retry is a continuation, so it keeps the span the first attempt
      // opened; anything still open from an earlier run is stale.
      if (!isRetry) {
        generateSpan?.end()
        generateSpan = startTraceSpan('comfyui.generate', {
          attributes: {
            'aipg.preset': preset.name,
            'aipg.mode': run.items[0]?.mode,
            'aipg.media_type': preset.mediaType,
            'aipg.batch_size': run.items.length,
            'aipg.keep_models_loaded': developerSettings.keepModelsLoaded,
          },
        })
      }

      // Surface progress immediately so the chat tool widget and the desktop
      // overlay show a "starting" state instead of nothing while the backend
      // boots / the request is queued.
      imageGeneration.processing = true
      imageGeneration.currentState = 'start_backend'

      try {
        const result = await withTraceSpan(
          'comfyui.start_backend',
          () => window.electronAPI.ensureComfyUIBackendRunning(),
          { parentId: generateSpan?.id },
        )
        if (!result.success) {
          errors.report(
            createAppError({
              category: 'generation',
              code: 'generation/backend-start-failed',
              userMessage: 'Failed to start the ComfyUI backend.',
              technicalMessage: result.error ?? 'ensureComfyUIBackendRunning returned failure',
              surface: 'toast',
              context: { serviceName: 'comfyui-backend' },
            }),
          )
          resetGenerationState()
          return false
        }

        if (result.starting) {
          console.info('ComfyUI backend is starting, queueing generation request')
          pendingGenerationRequest.value = { run }
          // Keep the 'start_backend' indicator up; the auto-retry will continue
          // this operation once the backend reaches 'running'.
          return true
        }
      } catch (error) {
        errors.report(error, {
          category: 'generation',
          code: 'generation/backend-check-failed',
          userMessage: 'Failed to check the ComfyUI backend.',
          surface: 'toast',
          context: { serviceName: 'comfyui-backend' },
        })
        resetGenerationState()
        return false
      }

      if (comfyUiState.value?.status !== 'running') {
        console.warn('ComfyUI backend is not running. Current status:', comfyUiState.value?.status)
        pendingGenerationRequest.value = { run }
        // Keep the 'start_backend' indicator up; the auto-retry continues once running.
        return true
      }

      if (websocket.value?.readyState !== WEBSOCKET_OPEN) {
        console.warn('Websocket not open')
        resetGenerationState()
        return false
      }

      // Validate required image inputs before execution
      const missingInputs = validateRequiredImageInputs(run.inputs)
      if (missingInputs.length > 0) {
        const inputLabels = missingInputs.join(', ')
        errors.report(
          createAppError({
            category: 'validation',
            code: 'generation/missing-image-inputs',
            userMessage: `Missing required image inputs: ${inputLabels}`,
            surface: 'toast',
          }),
        )
        resetGenerationState()
        return false
      }

      try {
        imageGeneration.processing = true
        imageGeneration.currentState = 'install_workflow_components'
        await installCustomNodesForPresetFully(preset)

        await ensureDummyWorkflowFixtures(preset, comfyBaseUrl.value)

        // Ensure OVMS image server is ready if the workflow uses OpenAI-compatible image nodes
        const ovmsImageUrl = await ensureOvmsImageServerIfNeeded(preset, run.inputs, run.params)
        if (ovmsImageUrl === false) {
          resetGenerationState()
          return false
        }

        const platform = await window.electronAPI.getPlatform()
        const mutableWorkflow: ComfyUIApiWorkflow = JSON.parse(
          JSON.stringify(preset.comfyUiApiWorkflow),
        )
        generateIdx = 0
        // The caller resolved and seeded every batch entry; the trace reports
        // what the items actually carry, not a re-rolled wildcard.
        const baseSeed = Number(run.items[0]?.settings.seed ?? run.params.seed)

        modifySettingInWorkflow(mutableWorkflow, 'inferenceSteps', run.params.inferenceSteps)
        modifySettingInWorkflow(mutableWorkflow, 'height', run.params.height)
        modifySettingInWorkflow(mutableWorkflow, 'width', run.params.width)
        modifySettingInWorkflow(mutableWorkflow, 'prompt', run.params.prompt)
        modifySettingInWorkflow(mutableWorkflow, 'negativePrompt', run.params.negativePrompt)

        await modifyDynamicSettingsInWorkflow(mutableWorkflow, platform, run.inputs)

        if (ovmsImageUrl) {
          injectOvmsImageUrl(mutableWorkflow, ovmsImageUrl)
        }

        bypassOptionalModelNodes(mutableWorkflow, run.inputs)
        normalizeModelPathsInWorkflow(mutableWorkflow, platform)

        loaderNodes.value = [
          ...findKeysByClassType(mutableWorkflow, 'CheckpointLoaderSimple'),
          ...findKeysByClassType(mutableWorkflow, 'Unet Loader (GGUF)'),
          ...findKeysByClassType(mutableWorkflow, 'DualCLIPLoader (GGUF)'),
        ]
        loadingNode = undefined
        loaderModels = Object.fromEntries(
          loaderNodes.value.map((node) => [
            node,
            {
              node,
              title: nodeTitle(mutableWorkflow, node),
              model: loaderModelNames(mutableWorkflow, node).join(', ') || undefined,
            },
          ]),
        )
        // The caller resolved and seeded every batch entry; the items it
        // queued are the run's tracked items.
        queuedImages = run.items
        // Everything that decides the output is resolved by now — seed, size,
        // steps and the preset's own workflow knobs — so the span can say what
        // this run was actually asked for.
        if (generateSpan) {
          const traced = comfyTraceParameters({
            preset: preset.name,
            mode: run.items[0]?.mode,
            mediaType: preset.mediaType,
            settings: run.items[0]?.settings ?? {},
            seed: baseSeed,
            batchSize: run.items.length,
            keepModelsLoaded: developerSettings.keepModelsLoaded,
            inputs: (run.items[0]?.dynamicSettings ?? []).map((input) => ({
              nodeTitle: input.nodeTitle,
              nodeInput: input.nodeInput,
              type: input.type,
              value: input.current,
            })),
            hasSourceImage: run.sourceImage !== undefined,
          })
          generateSpan.setAttributes(traced.attributes)
          generateSpan.setInput(traced.input)
        }
        for (const image of queuedImages) {
          modifySettingInWorkflow(mutableWorkflow, 'seed', `${image.settings.seed!.toFixed(0)}`)
          const result = await comfyFetch(`${comfyBaseUrl.value}/prompt`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              prompt: mutableWorkflow,
              client_id: clientId,
            }),
          })
          if (result.status > 299) {
            throw new Error(
              `ComfyUI Backend responded with ${result.status}: ${await result.text()}`,
            )
          }
        }
        imageGeneration.updateImage({
          ...queuedImages[0],
          state: 'generating',
        })
        imageGeneration.currentState = 'load_workflow_components'
        return true
      } catch (ex) {
        imageGeneration.failGeneration('The ComfyUI backend could not generate the image.')
        errors.report(ex, {
          category: 'generation',
          code: 'generation/request-failed',
          userMessage: 'The ComfyUI backend could not generate the image.',
          surface: 'toast',
          context: { serviceName: 'comfyui-backend' },
        })
        const promptStore = usePromptStore()
        promptStore.promptSubmitted = false
        return false
      }
    }

    async function freeMemoryAndUnloadModels() {
      await comfyFetch(`${comfyBaseUrl.value}/free`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ free_memory: true, unload_models: true }),
      })
    }

    async function stop() {
      imageGeneration.stopping = true
      try {
        await comfyFetch(`${comfyBaseUrl.value}/queue`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ clear: true }),
        })
        await comfyFetch(`${comfyBaseUrl.value}/interrupt`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        })
      } catch (error) {
        // Best-effort: even if the cancel request fails (e.g. backend already
        // gone), we still locally settle the in-flight items below so the UI is
        // never left stuck in a processing state.
        errors.report(error, {
          category: 'generation',
          code: 'generation/cancel-failed',
          userMessage: 'Could not reach the ComfyUI backend to cancel generation.',
          surface: 'silent',
          context: { serviceName: 'comfyui-backend' },
        })
      } finally {
        // Move in-flight items to a terminal 'stopped' state and unblock the UI.
        imageGeneration.cancelGeneration()
      }
    }

    return {
      generate,
      stop,
      free: freeMemoryAndUnloadModels,
      checkPresetRequirements,
      installMissingRequirements,
    }
  },
  {
    persist: {
      storage: demoAwareStorage,
      pick: [],
    },
  },
)

if (import.meta.hot) {
  import.meta.hot.accept(acceptHMRUpdate(useComfyUiPresets, import.meta.hot))
}
