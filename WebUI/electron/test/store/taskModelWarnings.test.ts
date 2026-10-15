import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope, nextTick, ref } from 'vue'
import type { AgentSessionSettings } from '@/types/agentSessionIpc'
import type { AgentTaskStep } from '@/types/agentTaskIpc'
import { PresetSchema, type Preset } from '@/lib/presetSchemas'
import { createCancellation } from '@/assets/js/errors/appError'

const EMBEDDING = 'ChristianAzinn/bge-small-en-v1.5-gguf/bge-small-en-v1.5.Q8_0.gguf'
const TTS_MODEL = 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice'

const DRAFT_IMAGE = PresetSchema.parse({
  type: 'comfy',
  backend: 'comfyui',
  comfyUiApiWorkflow: {},
  name: 'Draft Image',
  toolCategory: 'create-images',
  requiredModels: [
    { type: 'checkpoints', model: 'sdxl/lcm' },
    { type: 'vae', model: 'shared/vae' },
  ],
})
const EDIT_BY_PROMPT = PresetSchema.parse({
  type: 'comfy',
  backend: 'comfyui',
  comfyUiApiWorkflow: {},
  name: 'Edit By Prompt',
  toolCategory: 'edit-images',
  requiredModels: [{ type: 'vae', model: 'shared/vae' }],
})

let presetList: Preset[]
vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    get presets() {
      return presetList
    },
  }),
}))

const CHAT_MODEL = 'unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-Q4_K_M.gguf'
const MMPROJ = 'unsloth/Qwen3.8-27B-GGUF/mmproj-F16.gguf'

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    inferenceForSettings: (_preset: string, settings: AgentSessionSettings) => ({
      inference: {
        backend: settings.backend ?? 'llamaCPP',
        activeModel: settings.model ?? CHAT_MODEL,
        modelSupportsVision: true,
        embeddingBackend: 'llamaCPP',
        activeEmbeddingModel: settings.embeddingModel ?? EMBEDDING,
      },
    }),
    llmModelRefs: (_backend: string, model: string, options: { needsVision?: boolean } = {}) => [
      { repo_id: model, type: 'ggufLLM', backend: 'llama_cpp' },
      ...(options.needsVision ? [{ repo_id: MMPROJ, type: 'ggufLLM', backend: 'llama_cpp' }] : []),
    ],
  }),
}))

type CheckParam = { repo_id: string; type: string; backend: string }
let onDisk: Set<string>
const checkModelAlreadyLoaded = vi.fn(async (params: CheckParam[]) =>
  params.map((param) => ({
    ...param,
    model_path: `/models/${param.type}`,
    already_loaded: onDisk.has(param.repo_id),
  })),
)
vi.mock('@/assets/js/store/models', () => ({
  useModels: () => ({ checkModelAlreadyLoaded, hfToken: undefined }),
}))

vi.mock('@/assets/js/store/globalSetup', () => ({
  useGlobalSetup: () => ({ apiHost: 'http://127.0.0.1:59000' }),
}))

const SIZES: Record<string, string> = { 'sdxl/lcm': '6.46G', 'shared/vae': '319.14M' }
vi.mock('@/lib/modelDownloader', () => ({
  fetchModelMeta: vi.fn(async (list: CheckParam[]) =>
    list.map((item) => ({
      ...item,
      size: SIZES[item.repo_id] ?? '',
      gated: false,
      accessGranted: false,
    })),
  ),
}))

let speechModels: Record<string, CheckParam>
vi.mock('@/assets/js/speech/speechIO', () => ({ speechToolModels: () => speechModels }))

vi.mock('@/assets/js/store/devPresets', () => ({
  dummyWorkflowsOnly: () => false,
  DEV_PRESET_NAMES: new Set<string>(),
}))

const requestDownload = vi.fn(async (_models: unknown[]) => {})
vi.mock('@/assets/js/permissions/permissions', () => ({
  requestDownload: (models: unknown[]) => requestDownload(models),
}))

const report = vi.fn()
vi.mock('@/assets/js/store/errors', () => ({ useErrors: () => ({ report }) }))
vi.mock('@/assets/js/store/i18n', () => ({ useI18N: () => ({ state: {} }) }))

const { useTaskModelWarnings } = await import('@/assets/js/taskModelWarnings')

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await nextTick()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

function mount(initial: AgentSessionSettings, options?: { chatModelSteps: AgentTaskStep[] }) {
  const template = ref<AgentSessionSettings>(initial)
  const scope = effectScope()
  const warnings = scope.run(() =>
    useTaskModelWarnings(() => template.value, { chatModelSteps: () => options?.chatModelSteps }),
  )!
  return { template, warnings, stop: () => scope.stop() }
}

const missingAt = (repo_id: string, type: string, backend: string) => ({
  repo_id,
  type,
  backend,
  model_path: `/models/${type}`,
  already_loaded: false,
})

beforeEach(() => {
  vi.clearAllMocks()
  setActivePinia(createPinia())
  presetList = [DRAFT_IMAGE, EDIT_BY_PROMPT]
  onDisk = new Set()
  speechModels = {}
  requestDownload.mockImplementation(async () => {})
})

describe('useTaskModelWarnings', () => {
  it('warns about a missing embedding model while document search is on', async () => {
    const { warnings } = mount({ capabilities: ['rag'] })
    await settle()
    expect(warnings.warnings.value.certain).toEqual([
      {
        kind: 'embedding',
        models: [{ repo_id: EMBEDDING, type: 'embedding', backend: 'llama_cpp' }],
      },
    ])
    expect(warnings.warnings.value.maybe).toEqual([])
  })

  it('shows nothing once every needed model is on disk', async () => {
    onDisk = new Set([EMBEDDING])
    const { warnings } = mount({ capabilities: ['rag'] })
    await settle()
    expect(warnings.warnings.value).toEqual({ certain: [], maybe: [] })
    expect(warnings.missingCount.value).toBe(0)
  })

  it('counts a model two workflows share once', async () => {
    const { warnings } = mount({ capabilities: ['rag', 'media'] })
    await settle()
    // The embedding model, sdxl/lcm, and shared/vae used by both default workflows.
    expect(warnings.missingCount.value).toBe(3)
  })

  it('lists the default workflows’ and speech engine’s missing models with their sizes', async () => {
    speechModels = {
      synthesizeTextToSpeech: { repo_id: TTS_MODEL, type: 'TTS', backend: 'openvino' },
    }
    onDisk = new Set(['sdxl/lcm'])
    const { warnings } = mount({ capabilities: ['media'] })
    await settle()
    expect(warnings.warnings.value.maybe).toEqual([
      {
        kind: 'workflow',
        tool: 'comfyUI',
        mediaType: 'image',
        workflow: 'Draft Image',
        models: [{ repo_id: 'shared/vae', type: 'vae', backend: 'comfyui', size: '319.14M' }],
      },
      {
        kind: 'workflow',
        tool: 'comfyUiImageEdit',
        mediaType: 'image',
        workflow: 'Edit By Prompt',
        models: [{ repo_id: 'shared/vae', type: 'vae', backend: 'comfyui', size: '319.14M' }],
      },
      {
        kind: 'speech',
        tool: 'synthesizeTextToSpeech',
        models: [{ repo_id: TTS_MODEL, type: 'TTS', backend: 'openvino' }],
      },
    ])
    expect(requestDownload).not.toHaveBeenCalled()
  })

  it('updates live as capabilities and tools are toggled', async () => {
    const { template, warnings } = mount({ capabilities: [] })
    await settle()
    expect(warnings.warnings.value).toEqual({ certain: [], maybe: [] })

    template.value = { capabilities: ['media'] }
    await settle()
    expect(
      warnings.warnings.value.maybe.map((need) => 'workflow' in need && need.workflow),
    ).toEqual(['Draft Image', 'Edit By Prompt'])

    template.value = { capabilities: ['media'], builtinToolEnablement: { comfyUI: false } }
    await settle()
    expect(
      warnings.warnings.value.maybe.map((need) => 'workflow' in need && need.workflow),
    ).toEqual(['Edit By Prompt'])
  })

  it('shows no outdated warning when the check for a changed template fails', async () => {
    const { template, warnings } = mount({ capabilities: ['rag'] })
    await settle()
    expect(warnings.warnings.value.certain).toHaveLength(1)

    checkModelAlreadyLoaded.mockRejectedValueOnce(new Error('backend down'))
    template.value = { capabilities: ['rag', 'media'] }
    await settle()

    expect(warnings.warnings.value).toEqual({ certain: [], maybe: [] })
  })

  it('downloads exactly the listed models, each once, and clears what arrived', async () => {
    const { warnings } = mount({ capabilities: ['media', 'rag'] })
    await settle()
    requestDownload.mockImplementation(async () => {
      onDisk = new Set([EMBEDDING, 'sdxl/lcm', 'shared/vae'])
    })

    await warnings.download(warnings.warnings.value.maybe)

    expect(requestDownload).toHaveBeenCalledTimes(1)
    expect(requestDownload.mock.calls[0][0]).toEqual([
      missingAt('sdxl/lcm', 'checkpoints', 'comfyui'),
      missingAt('shared/vae', 'vae', 'comfyui'),
    ])
    await settle()
    expect(warnings.warnings.value).toEqual({ certain: [], maybe: [] })
  })

  it('keeps the warning without an error when the download is declined', async () => {
    requestDownload.mockRejectedValue(createCancellation())
    const { warnings } = mount({ capabilities: ['rag'] })
    await settle()

    await warnings.download(warnings.warnings.value.certain)

    expect(warnings.downloadError.value).toBe('')
    expect(warnings.warnings.value.certain).toHaveLength(1)
  })

  it('shows the error when the download fails', async () => {
    requestDownload.mockRejectedValue(new Error('disk full'))
    const { warnings } = mount({ capabilities: ['rag'] })
    await settle()

    await warnings.download(warnings.warnings.value.certain)

    expect(warnings.downloadError.value).toContain('disk full')
    expect(warnings.warnings.value.certain).toHaveLength(1)
  })
})

describe('useTaskModelWarnings with the chat model checked', () => {
  const textStep: AgentTaskStep = { id: 's1', prompt: 'Summarize the notes' }

  it('leaves the chat model out unless asked to check it', async () => {
    const { warnings } = mount({ capabilities: [] })
    await settle()
    expect(warnings.warnings.value).toEqual({ certain: [], maybe: [] })
  })

  it('lists a missing chat model first among the certain needs', async () => {
    const { warnings } = mount({ capabilities: ['rag'] }, { chatModelSteps: [textStep] })
    await settle()
    expect(warnings.warnings.value.certain).toEqual([
      { kind: 'chat', models: [{ repo_id: CHAT_MODEL, type: 'ggufLLM', backend: 'llama_cpp' }] },
      {
        kind: 'embedding',
        models: [{ repo_id: EMBEDDING, type: 'embedding', backend: 'llama_cpp' }],
      },
    ])
  })

  it('adds the vision projector when a Step hands the model an image', async () => {
    const imageStep = { id: 's2', prompt: 'Describe @attachments/photo.png' }
    const { warnings } = mount({ capabilities: [] }, { chatModelSteps: [imageStep] })
    await settle()
    expect(warnings.warnings.value.certain).toEqual([
      {
        kind: 'chat',
        models: [
          { repo_id: CHAT_MODEL, type: 'ggufLLM', backend: 'llama_cpp' },
          { repo_id: MMPROJ, type: 'ggufLLM', backend: 'llama_cpp' },
        ],
      },
    ])
  })

  it('shows nothing for a chat model on disk or a cloud model', async () => {
    onDisk = new Set([CHAT_MODEL])
    const { template, warnings } = mount({ capabilities: [] }, { chatModelSteps: [textStep] })
    await settle()
    expect(warnings.warnings.value).toEqual({ certain: [], maybe: [] })

    onDisk = new Set()
    template.value = { backend: 'cloud', capabilities: [] }
    await settle()
    expect(warnings.warnings.value).toEqual({ certain: [], maybe: [] })
    expect(checkModelAlreadyLoaded).toHaveBeenCalledTimes(1)
  })

  it('downloads the chat model only when asked to', async () => {
    const { warnings } = mount({ capabilities: [] }, { chatModelSteps: [textStep] })
    await settle()
    expect(requestDownload).not.toHaveBeenCalled()

    await warnings.download(warnings.warnings.value.certain)

    expect(requestDownload.mock.calls[0][0]).toEqual([
      missingAt(CHAT_MODEL, 'ggufLLM', 'llama_cpp'),
    ])
  })
})
