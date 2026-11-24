import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyVariant, ComfyUiPresetSchema, type ComfyUiPreset } from '@/lib/presetSchemas'

const submitArtifactRunMock = vi.hoisted(() => vi.fn())
vi.mock('../../kernel/orchestrator.ts', () => ({
  submitArtifactRun: (...args: unknown[]) => submitArtifactRunMock(...args),
  cancelArtifactRun: vi.fn(),
}))
vi.mock('../../artifact/catalog.ts', () => ({
  resolveComfyEntry: (
    catalog: { comfy: Map<string, ComfyUiPreset> },
    name: string,
    variant?: string,
  ) => {
    const base = catalog.comfy.get(name)
    if (!base) return null
    const requested = variant ?? base.variants?.[0]?.name
    return structuredClone(requested ? applyVariant(base, requested) : base)
  },
}))

const { runInProcessComfyTool, setMediaCatalogProvider, resetMediaCatalogProviderForTest } =
  await import('../../artifact/inProcessComfy')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetsDir = path.resolve(__dirname, '../../../../modes/base/presets')
const load = (file: string) =>
  ComfyUiPresetSchema.parse(JSON.parse(readFileSync(path.join(presetsDir, file), 'utf-8')))

type Params = { inferenceSteps: number; width: number; height: number }

async function submittedParams(
  presetFile: string,
  kind: 'create' | 'edit',
  args: Record<string, unknown> = {},
): Promise<Params> {
  const preset = load(presetFile)
  setMediaCatalogProvider(async () => ({
    comfy: new Map([[preset.name, preset]]),
    chat: new Map(),
  }))
  await runInProcessComfyTool({
    kind,
    args: { workflow: preset.name, prompt: 'a lighthouse', ...args },
    source: kind === 'edit' ? 'data:image/png;base64,abc' : undefined,
    origin: 'agent',
    keepModelsLoaded: false,
  })
  return submitArtifactRunMock.mock.calls.at(-1)?.[0].params as Params
}

describe('runInProcessComfyTool defaults', () => {
  beforeEach(() => {
    submitArtifactRunMock.mockReset()
    submitArtifactRunMock.mockResolvedValue({ state: 'completed', items: [] })
  })
  afterEach(() => resetMediaCatalogProviderForTest())

  it("uses the resolved variant's step count when the model sends none", async () => {
    expect((await submittedParams('minimax-h3-video.json', 'create')).inferenceSteps).toBe(8)
    expect(
      (await submittedParams('minimax-h3-video.json', 'create', { variant: 'Standard' }))
        .inferenceSteps,
    ).toBe(20)
  })

  it('keeps a step count the model asked for', async () => {
    const params = await submittedParams('minimax-h3-video.json', 'create', { inferenceSteps: 12 })
    expect(params.inferenceSteps).toBe(12)
  })

  it("renders at the preset's default size when no aspect ratio is given", async () => {
    expect(await submittedParams('minimax-h3-image.json', 'create')).toMatchObject({
      width: 4096,
      height: 4096,
    })
    expect(await submittedParams('minimax-h3-video.json', 'create')).toMatchObject({
      width: 896,
      height: 512,
    })
  })

  it("picks the megapixel tier nearest the preset's default for an aspect-only request", async () => {
    expect(
      await submittedParams('minimax-h3-image.json', 'create', { aspectRatio: '16/9' }),
    ).toMatchObject({ width: 5472, height: 3072 })
  })

  it('sizes an edit-kind video from the preset instead of 512x512', async () => {
    expect(await submittedParams('minimax-h3-i2v.json', 'edit')).toMatchObject({
      inferenceSteps: 8,
      width: 896,
      height: 512,
    })
  })
})
