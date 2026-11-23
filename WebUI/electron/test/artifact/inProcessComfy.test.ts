import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import type { ComfyUiPreset } from '@/lib/presetSchemas'
import type { ArtifactRunResult } from '../../artifact/runner'

// runInProcessComfyTool is the funnel every agent / chat / specialist media
// call goes through. These tests pin the same param chain the panel path
// (runArtifact.resolveParams) uses: model-passed value → preset-declared
// default → last-resort fallback.

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => os.tmpdir()) },
}))

vi.mock('../../observability/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const submitArtifactRunMock =
  vi.fn<(payload: unknown, options?: unknown) => Promise<ArtifactRunResult>>()
const cancelArtifactRunMock = vi.fn<(runId: string) => void>()
vi.mock('../../kernel/orchestrator.ts', () => ({
  submitArtifactRun: submitArtifactRunMock,
  cancelArtifactRun: cancelArtifactRunMock,
}))

const { runInProcessComfyTool, setMediaCatalogProvider, resetMediaCatalogProviderForTest } =
  await import('../../artifact/inProcessComfy.ts')

type ParamSettingName =
  | 'prompt'
  | 'seed'
  | 'inferenceSteps'
  | 'width'
  | 'height'
  | 'resolution'
  | 'batchSize'
  | 'negativePrompt'
  | 'safetyCheck'
  | 'showPreview'

function paramSetting(
  settingName: ParamSettingName,
  defaultValue: string | number | boolean,
  type: 'string' | 'number' = 'number',
) {
  return { type, label: settingName, settingName, defaultValue, displayed: true, modifiable: true }
}

function comfyPresetFixture(overrides: Partial<ComfyUiPreset> & { name: string }): ComfyUiPreset {
  return {
    type: 'comfy',
    backend: 'comfyui',
    category: 'create-images',
    toolCategory: 'create-images',
    settings: [],
    comfyUiApiWorkflow: {},
    ...overrides,
  } as unknown as ComfyUiPreset
}

function installCatalog(presets: ComfyUiPreset[]) {
  setMediaCatalogProvider(async () => ({
    comfy: new Map(presets.map((preset) => [preset.name, preset])),
    chat: new Map(),
  }))
}

function createRequest(args: Record<string, unknown>) {
  return {
    kind: 'create' as const,
    toolName: 'comfyUI',
    args,
    origin: 'agent' as const,
    keepModelsLoaded: false,
  }
}

function submittedParams(): Record<string, unknown> {
  const payload = submitArtifactRunMock.mock.calls[0][0] as { params: Record<string, unknown> }
  return payload.params
}

beforeEach(() => {
  resetMediaCatalogProviderForTest()
  submitArtifactRunMock.mockReset()
  cancelArtifactRunMock.mockReset()
  submitArtifactRunMock.mockResolvedValue({ state: 'completed', items: [] } as ArtifactRunResult)
})

describe('runInProcessComfyTool params', () => {
  it('lets the model-passed value win over the preset default', async () => {
    installCatalog([
      comfyPresetFixture({
        name: 'P',
        settings: [
          paramSetting('inferenceSteps', 25),
          paramSetting('negativePrompt', 'lowres', 'string'),
          paramSetting('seed', 7),
          paramSetting('resolution', '1024x768', 'string'),
          paramSetting('batchSize', 3),
        ],
      }),
    ])

    await runInProcessComfyTool(
      createRequest({
        workflow: 'P',
        prompt: 'a cat',
        inferenceSteps: 30,
        negativePrompt: 'blurry',
        seed: 42,
        batchSize: 2,
        resolution: '512x512',
      }),
    )

    expect(submittedParams()).toMatchObject({
      inferenceSteps: 30,
      negativePrompt: 'blurry',
      seed: 42,
      batchSize: 2,
      width: 512,
      height: 512,
    })
  })

  it('falls back to the preset-declared defaults when the model passes nothing', async () => {
    installCatalog([
      comfyPresetFixture({
        name: 'P',
        settings: [
          paramSetting('inferenceSteps', 25),
          paramSetting('negativePrompt', 'lowres', 'string'),
          paramSetting('seed', 7),
          paramSetting('resolution', '1024x768', 'string'),
          paramSetting('batchSize', 3),
        ],
      }),
    ])

    await runInProcessComfyTool(createRequest({ workflow: 'P', prompt: 'a cat' }))

    expect(submittedParams()).toMatchObject({
      inferenceSteps: 25,
      negativePrompt: 'lowres',
      seed: 7,
      width: 1024,
      height: 768,
      batchSize: 3,
    })
  })

  it('uses the last-resort fallbacks when the preset declares nothing', async () => {
    installCatalog([comfyPresetFixture({ name: 'P' })])

    await runInProcessComfyTool(createRequest({ workflow: 'P', prompt: 'a cat' }))

    expect(submittedParams()).toMatchObject({
      inferenceSteps: 6,
      negativePrompt: 'nsfw',
      seed: -1,
      width: 512,
      height: 512,
      batchSize: 1,
    })
  })

  it('applies a prompt-specified size and steps to an edit run', async () => {
    installCatalog([comfyPresetFixture({ name: 'P', toolCategory: 'edit-images' })])

    await runInProcessComfyTool({
      kind: 'edit',
      toolName: 'comfyUiImageEdit',
      args: { workflow: 'P', prompt: 'sharpen', resolution: '1024x1024', inferenceSteps: 20 },
      source: 'data:image/png;base64,aGk=',
      origin: 'agent',
      keepModelsLoaded: false,
    })

    const payload = submitArtifactRunMock.mock.calls[0][0] as {
      mode: string
      params: Record<string, unknown>
    }
    expect(payload.mode).toBe('imageEdit')
    expect(payload.params).toMatchObject({
      inferenceSteps: 20,
      width: 1024,
      height: 1024,
      batchSize: 1,
    })
  })

  it('forces batch 1 for video presets', async () => {
    installCatalog([comfyPresetFixture({ name: 'P', mediaType: 'video' })])

    await runInProcessComfyTool(createRequest({ workflow: 'P', prompt: 'a clip', batchSize: 2 }))

    expect(submittedParams()).toMatchObject({ batchSize: 1 })
  })
})
