import { beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import type { ComfyInput, ComfyUiPreset } from '@/lib/presetSchemas'
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

function submittedInputs(): Array<{ label: string; current: unknown }> {
  const payload = submitArtifactRunMock.mock.calls[0][0] as {
    inputs: Array<{ label: string; current: unknown }>
  }
  return payload.inputs
}

function comfyInputFixture(overrides: Partial<ComfyInput> & { label: string }): ComfyInput {
  return {
    type: 'string',
    nodeTitle: 'Node',
    nodeInput: 'value',
    displayed: true,
    modifiable: true,
    ...overrides,
  } as ComfyInput
}

/** A preset with the inputs the dynamic-inputs tests merge against. */
function installInputCatalog() {
  installCatalog([
    comfyPresetFixture({
      name: 'P',
      settings: [
        comfyInputFixture({
          label: 'Guidance Scale',
          type: 'number',
          nodeInput: 'guidance',
          defaultValue: 7,
          min: 1,
          max: 20,
        }),
        comfyInputFixture({
          label: 'Sampling Method',
          nodeInput: 'sampler',
          options: ['euler', 'dpmpp_2m'],
          defaultValue: 'euler',
        }),
        comfyInputFixture({
          label: 'Device',
          nodeTitle: 'OpenVINO Upscale',
          nodeInput: 'device',
          defaultValue: 'AUTO',
        }),
        comfyInputFixture({ label: 'Image', type: 'image' }),
      ],
    }),
  ])
}

function currentOf(label: string): unknown {
  return submittedInputs().find((i) => i.label === label)?.current
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

describe('runInProcessComfyTool size snapping', () => {
  it('snaps an unsupported resolution to the closest supported one and reports it', async () => {
    installCatalog([comfyPresetFixture({ name: 'P' })])

    const output = (await runInProcessComfyTool(
      createRequest({ workflow: 'P', prompt: 'a cat', resolution: '2048x2048' }),
    )) as Record<string, unknown>

    expect(submittedParams()).toMatchObject({ width: 1024, height: 1024 })
    expect(output.size).toBe('1024x1024')
    expect(output.sizeNotice).toContain('Requested 2048x2048')
    expect(output.sizeNotice).toContain('1024x1024')
  })

  it('does not report a notice when the requested resolution is supported', async () => {
    installCatalog([comfyPresetFixture({ name: 'P' })])

    const output = (await runInProcessComfyTool(
      createRequest({ workflow: 'P', prompt: 'a cat', resolution: '512x512' }),
    )) as Record<string, unknown>

    expect(submittedParams()).toMatchObject({ width: 512, height: 512 })
    expect(output.size).toBe('512x512')
    expect(output.sizeNotice).toBeUndefined()
  })

  it('snaps an unsupported megapixel tier to the closest one and reports it', async () => {
    installCatalog([comfyPresetFixture({ name: 'P' })])

    const output = (await runInProcessComfyTool(
      createRequest({ workflow: 'P', prompt: 'a cat', megapixels: '1.5', aspectRatio: '1/1' }),
    )) as Record<string, unknown>

    expect(submittedParams()).toMatchObject({ width: 1024, height: 1024 })
    expect(output.size).toBe('1024x1024')
    expect(output.sizeNotice).toContain('Requested 1.5 megapixels at 1/1')
    expect(output.sizeNotice).toContain('1024x1024')
  })

  it('reports the size the runner stamped on the item, not the requested params', async () => {
    installCatalog([comfyPresetFixture({ name: 'P' })])
    submitArtifactRunMock.mockResolvedValue({
      state: 'completed',
      items: [
        {
          id: 'i1',
          type: 'image',
          imageUrl: 'aipg-media://a.png',
          mode: 'imageGen',
          settings: { resolution: '704x704' },
        },
      ],
    } as unknown as ArtifactRunResult)

    const output = (await runInProcessComfyTool(
      createRequest({ workflow: 'P', prompt: 'a cat', resolution: '600x600' }),
    )) as Record<string, unknown>

    expect(output.size).toBe('704x704')
    expect(output.sizeNotice).toContain('Requested 600x600')
    expect(output.sizeNotice).toContain('704x704')
  })

  it('omits size and notice when the run does not complete', async () => {
    installCatalog([comfyPresetFixture({ name: 'P' })])
    submitArtifactRunMock.mockResolvedValue({ state: 'cancelled', items: [] } as ArtifactRunResult)

    const output = (await runInProcessComfyTool(
      createRequest({ workflow: 'P', prompt: 'a cat', resolution: '2048x2048' }),
    )) as Record<string, unknown>

    expect(output.size).toBeUndefined()
    expect(output.sizeNotice).toBeUndefined()
  })
})

describe('runInProcessComfyTool dynamicInputs', () => {
  it('applies label-keyed overrides, matching labels and option values case-insensitively', async () => {
    installInputCatalog()

    const output = (await runInProcessComfyTool(
      createRequest({
        workflow: 'P',
        prompt: 'a cat',
        dynamicInputs: { 'guidance scale': 12, 'Sampling Method': 'DPMPP_2M' },
      }),
    )) as Record<string, unknown>

    expect(currentOf('Guidance Scale')).toBe(12)
    expect(currentOf('Sampling Method')).toBe('dpmpp_2m')
    expect(output.inputsNotice).toBeUndefined()
  })

  it('clamps an out-of-range number and reports the adjustment', async () => {
    installInputCatalog()

    const output = (await runInProcessComfyTool(
      createRequest({ workflow: 'P', prompt: 'a cat', dynamicInputs: { 'Guidance Scale': 100 } }),
    )) as Record<string, unknown>

    expect(currentOf('Guidance Scale')).toBe(20)
    expect(output.inputsNotice).toContain('"Guidance Scale"')
    expect(output.inputsNotice).toContain('20')
  })

  it('ignores unknown labels and values outside the options, and reports both', async () => {
    installInputCatalog()

    const output = (await runInProcessComfyTool(
      createRequest({
        workflow: 'P',
        prompt: 'a cat',
        dynamicInputs: { Nope: 1, 'Sampling Method': 'bogus' },
      }),
    )) as Record<string, unknown>

    expect(currentOf('Guidance Scale')).toBe(7)
    expect(currentOf('Sampling Method')).toBe('euler')
    expect(output.inputsNotice).toContain('"Nope" is not an input of this workflow')
    expect(output.inputsNotice).toContain('"Sampling Method"')
    expect(output.inputsNotice).toContain('euler, dpmpp_2m')
  })

  it('never lets the prompt choose the inference device or an image input', async () => {
    installInputCatalog()

    const output = (await runInProcessComfyTool(
      createRequest({
        workflow: 'P',
        prompt: 'a cat',
        dynamicInputs: { Device: 'GPU', Image: 'data:image/png;base64,aGk=' },
      }),
    )) as Record<string, unknown>

    expect(currentOf('Device')).toBe('AUTO')
    expect(currentOf('Image')).toBeUndefined()
    expect(output.inputsNotice).toContain('inference device')
    expect(output.inputsNotice).toContain('"Image" cannot be set via the prompt')
  })

  it('keeps the preset-declared input defaults when none are passed', async () => {
    installInputCatalog()

    const output = (await runInProcessComfyTool(
      createRequest({ workflow: 'P', prompt: 'a cat' }),
    )) as Record<string, unknown>

    expect(currentOf('Guidance Scale')).toBe(7)
    expect(currentOf('Sampling Method')).toBe('euler')
    expect(currentOf('Device')).toBe('AUTO')
    expect(output.inputsNotice).toBeUndefined()
  })

  it('omits the notice when the run does not complete', async () => {
    installInputCatalog()
    submitArtifactRunMock.mockResolvedValue({ state: 'cancelled', items: [] } as ArtifactRunResult)

    const output = (await runInProcessComfyTool(
      createRequest({ workflow: 'P', prompt: 'a cat', dynamicInputs: { Nope: 1 } }),
    )) as Record<string, unknown>

    expect(output.inputsNotice).toBeUndefined()
  })
})
