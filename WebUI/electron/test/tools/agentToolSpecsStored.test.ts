import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolsForTurn } from '@/lib/storedSessionInference'
import { turnMediaToolSettings } from '@/lib/mediaToolSettings'

// The live chat store stands for the open Session's settings; a stored turn must not read it.
const live = vi.hoisted(() => ({
  toolDelegationEnabled: true,
  tools: {} as Record<string, boolean>,
  workflows: {} as Record<string, boolean>,
  defaults: {} as Record<string, string>,
}))

vi.mock('@/assets/js/store/textInference', () => ({
  useTextInference: () => ({
    get toolDelegationEnabled() {
      return live.toolDelegationEnabled
    },
    isBuiltinToolEnabled: (name: string) => live.tools[name] ?? name !== 'captureScreenshot',
    isWorkflowPresetEnabled: (name: string) => live.workflows[name] ?? true,
    getDefaultWorkflow: (slot: string, available: string[]) =>
      live.defaults[slot] && available.includes(live.defaults[slot])
        ? live.defaults[slot]
        : (available[0] ?? null),
  }),
}))

const preset = (name: string, toolCategory: string, mediaType = 'image') => ({
  name,
  type: 'comfy',
  backend: 'comfyui',
  category: toolCategory,
  toolCategory,
  mediaType,
  settings: [],
})

vi.mock('@/assets/js/store/presets', () => ({
  usePresets: () => ({
    presets: [
      preset('Draft Image', 'create-images'),
      preset('HD Image', 'create-images'),
      preset('Pro Image', 'create-images'),
      preset('Edit By Prompt', 'edit-images'),
      preset('Image To 3D Model', 'edit-images', 'model3d'),
    ],
  }),
}))

vi.mock('@/assets/js/store/devPresets', () => ({
  DEV_PRESET_NAMES: new Set<string>(),
  dummyWorkflowsOnly: () => false,
}))

vi.mock('@/assets/js/store/models', () => ({ useModels: () => ({}) }))
vi.mock('@/assets/js/toast.ts', () => ({}))

const { getAgentToolSpecs } = await import('@/assets/js/tools/agentBridge')
const { serializeMediaAgentInner } = await import('@/assets/js/agents/mediaAgent')

function stored(overrides: Partial<ToolsForTurn> = {}): ToolsForTurn {
  return {
    toolDelegationEnabled: true,
    builtinToolEnablement: {},
    builtinToolPresetEnablement: {},
    builtinToolDefaultPresets: {},
    onNpu: false,
    ...overrides,
  }
}

const onlyHdImage = { 'Draft Image': false, 'Pro Image': false }

function workflowEnum(spec: { inputSchema: Record<string, unknown> } | undefined): unknown {
  const properties = spec?.inputSchema.properties as Record<string, { enum?: unknown }>
  return properties.workflow.enum
}

beforeEach(() => {
  live.toolDelegationEnabled = true
  live.tools = {}
  live.workflows = {}
  live.defaults = {}
})

describe('a stored turn with delegation off', () => {
  it('offers generateImage only the workflows its settings enable', () => {
    const specs = getAgentToolSpecs(
      stored({ toolDelegationEnabled: false, builtinToolPresetEnablement: onlyHdImage }),
    )
    const generate = specs.find((spec) => spec.name === 'generateImage')

    expect(workflowEnum(generate)).toEqual(['HD Image'])
    expect(generate?.description).not.toContain('Draft Image')
    expect(generate?.description).not.toContain('Pro Image')
    expect(generate?.defaultWorkflow).toBe('HD Image')
    expect(generate?.allowedWorkflows).toEqual(['HD Image'])
  })

  it("uses the stored default workflows, not the window's", () => {
    live.defaults = { 'comfyUI:image': 'Pro Image' }
    const specs = getAgentToolSpecs(
      stored({
        toolDelegationEnabled: false,
        builtinToolDefaultPresets: { 'comfyUI:image': 'HD Image' },
      }),
    )
    expect(specs.find((spec) => spec.name === 'generateImage')?.defaultWorkflow).toBe('HD Image')
  })

  it('offers editImage only its enabled edit workflows', () => {
    const specs = getAgentToolSpecs(
      stored({
        toolDelegationEnabled: false,
        builtinToolPresetEnablement: { 'Image To 3D Model': false },
      }),
    )
    const edit = specs.find((spec) => spec.name === 'editImage')
    expect(workflowEnum(edit)).toEqual(['Edit By Prompt'])
    expect(edit?.allowedWorkflows).toEqual(['Edit By Prompt'])
  })

  it('gets no image tool when its settings turn the image tool off', () => {
    const specs = getAgentToolSpecs(
      stored({ toolDelegationEnabled: false, builtinToolEnablement: { comfyUI: false } }),
    )
    expect(specs.map((spec) => spec.name)).not.toContain('generateImage')
    expect(specs.map((spec) => spec.name)).toContain('editImage')
  })

  it('gets no image tool when its settings enable none of its workflows', () => {
    const specs = getAgentToolSpecs(
      stored({
        toolDelegationEnabled: false,
        builtinToolPresetEnablement: { ...onlyHdImage, 'HD Image': false },
      }),
    )
    expect(specs.map((spec) => spec.name)).not.toContain('generateImage')
  })
})

describe('a stored turn with delegation on', () => {
  it("gets no media tool when its settings turn both media tools off, whatever the window's", () => {
    const specs = getAgentToolSpecs(
      stored({ builtinToolEnablement: { comfyUI: false, comfyUiImageEdit: false } }),
    )
    expect(specs.map((spec) => spec.name)).not.toContain('media')
  })

  it("keeps the media tool when the window's toggles are off but its own are on", () => {
    live.tools = { comfyUI: false, comfyUiImageEdit: false }
    expect(getAgentToolSpecs(stored()).map((spec) => spec.name)).toContain('media')
  })

  it("hands the specialist only the turn's enabled workflows", () => {
    const tools = stored({
      builtinToolEnablement: { comfyUiImageEdit: false },
      builtinToolPresetEnablement: onlyHdImage,
    })
    const inner = serializeMediaAgentInner(turnMediaToolSettings(tools))

    expect(inner?.toolSpecs.map((spec) => spec.name)).toEqual(['comfyUI'])
    expect(workflowEnum(inner?.toolSpecs[0])).toEqual(['HD Image'])
    expect(inner?.toolSpecs[0].description).not.toContain('Draft Image')
    expect(inner?.repairData).toEqual({
      comfyUI: { names: ['HD Image'], defaultWorkflow: 'HD Image' },
    })
  })
})

describe('a live turn', () => {
  it("reads the window's settings, as before", () => {
    live.toolDelegationEnabled = false
    live.workflows = { 'Pro Image': false }
    live.defaults = { 'comfyUI:image': 'HD Image' }
    const generate = getAgentToolSpecs().find((spec) => spec.name === 'generateImage')

    expect(workflowEnum(generate)).toEqual(['Draft Image', 'HD Image'])
    expect(generate?.defaultWorkflow).toBe('HD Image')
  })

  it("hands the specialist the window's workflows", () => {
    live.workflows = { 'Draft Image': false }
    const inner = serializeMediaAgentInner()
    expect(inner?.repairData.comfyUI?.names).toEqual(['HD Image', 'Pro Image'])
    expect(inner?.repairData.comfyUiImageEdit?.names).toEqual([
      'Edit By Prompt',
      'Image To 3D Model',
    ])
  })
})
