import { describe, expect, it } from 'vitest'
import {
  presetsInMode,
  promptBarModel,
  type DeviceChip,
  type PromptBarInput,
} from '@/lib/promptBarModel'
import type { ChatPreset, ComfyUiPreset, Preset } from '@/lib/presetSchemas'

const gpu = { id: '0', name: 'Intel(R) Arc(TM) B580 Graphics', selected: true }

const assistant = {
  type: 'chat',
  name: 'Assistant',
  category: 'chat',
  image: 'assistant.png',
  backends: ['llamaCPP', 'openVINO'],
  displayPriority: 0,
  tags: [],
  settings: [],
} as ChatPreset

function comfy(name: string, requiredModels: ComfyUiPreset['requiredModels']): ComfyUiPreset {
  return {
    type: 'comfy',
    name,
    category: 'create-images',
    backend: 'comfyui',
    comfyUiApiWorkflow: {},
    displayPriority: 0,
    tags: [],
    settings: [],
    requiredModels,
  }
}

function input(overrides: Partial<PromptBarInput>): PromptBarInput {
  return {
    activePreset: assistant,
    presetLabel: (name) => name,
    machine: {
      chatBackend: 'llamaCPP',
      chatModel: 'unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf',
    },
    ...overrides,
  }
}

describe('promptBarModel header chips', () => {
  it('reads backend, device, model, preset for a chat preset', () => {
    const { headerChips } = promptBarModel(
      input({
        machine: {
          chatBackend: 'llamaCPP',
          chatModel: 'unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf',
          device: gpu,
        },
      }),
    )
    expect(headerChips).toEqual([
      { kind: 'backend', backend: 'llamaCPP' },
      {
        kind: 'device',
        name: 'Intel(R) Arc(TM) B580 Graphics',
        label: 'Arc B580 GPU',
        category: 'gpu',
        categoryLabel: 'GPU',
      },
      {
        kind: 'model',
        name: 'Qwen3.5-9B-Q4_K_M',
        id: 'unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf',
        source: 'chat',
      },
      { kind: 'preset', name: 'Assistant', label: 'Assistant', image: 'assistant.png' },
    ])
  })

  it('names ComfyUI and the checkpoint for a comfy preset, never the chat backend', () => {
    const hdImage = comfy('HD Image', [
      { type: 'checkpoints', model: 'RunDiffusion/Juggernaut-XL-v9/Juggernaut-XL_v9.safetensors' },
      { type: 'nsfwdetector', model: 'AdamCodd/vit-base-nsfw-detector/model.safetensors' },
    ])
    const { headerChips } = promptBarModel(
      input({
        activePreset: hdImage,
        machine: { chatBackend: 'openVINO', chatModel: 'OpenVINO/Qwen3-8B-int4-ov', device: gpu },
      }),
    )
    expect(headerChips).toEqual([
      { kind: 'backend', backend: 'comfyui' },
      {
        kind: 'device',
        name: 'Intel(R) Arc(TM) B580 Graphics',
        label: 'Arc B580 GPU',
        category: 'gpu',
        categoryLabel: 'GPU',
      },
      {
        kind: 'model',
        name: 'Juggernaut-XL_v9',
        id: 'RunDiffusion/Juggernaut-XL-v9/Juggernaut-XL_v9.safetensors',
        source: 'comfy',
      },
      { kind: 'preset', name: 'HD Image', label: 'HD Image', image: undefined },
    ])
  })

  it('leaves the model chip out when a comfy preset has no single model', () => {
    const manual = comfy('Manual', [
      { type: 'checkpoints', model: 'RunDiffusion/Juggernaut-XL-v9/Juggernaut-XL_v9.safetensors' },
      { type: 'checkpoints', model: 'Lykon/DreamShaper/DreamShaper_8_pruned.safetensors' },
    ])
    const colorize = comfy('Colorize', undefined)
    for (const preset of [manual, colorize]) {
      const kinds = promptBarModel(input({ activePreset: preset })).headerChips.map((c) => c.kind)
      expect(kinds).toEqual(['backend', 'preset'])
    }
  })

  it('takes the diffusion model over a checkpoint-typed side file', () => {
    const ltx = comfy('LTX-2.3', [
      { type: 'unet', model: 'unsloth/LTX-2.3-GGUF/ltx-2.3-22b-distilled-Q4_K_S.gguf' },
      { type: 'clip', model: 'unsloth/gemma-3-12b-it-GGUF/gemma-3-12b-it-Q3_K_M.gguf' },
      { type: 'checkpoints', model: 'unsloth/LTX-2.3-GGUF/vae/audio_vae.safetensors' },
    ])
    const model = promptBarModel(input({ activePreset: ltx })).headerChips.find(
      (c) => c.kind === 'model',
    )
    expect(model).toMatchObject({ name: 'ltx-2.3-22b-distilled-Q4_K_S', source: 'comfy' })
  })

  it('shows no local device on the cloud backend', () => {
    const { headerChips } = promptBarModel(
      input({ machine: { chatBackend: 'cloud', chatModel: 'gpt-5-mini', device: gpu } }),
    )
    expect(headerChips).toEqual([
      { kind: 'backend', backend: 'cloud' },
      { kind: 'model', name: 'gpt-5-mini', id: 'gpt-5-mini', source: 'chat' },
      { kind: 'preset', name: 'Assistant', label: 'Assistant', image: 'assistant.png' },
    ])
  })

  it('brands the preset chip label but keeps the preset name', () => {
    const gameAgent = { ...assistant, name: 'Game Agent', agentPreset: true }
    const preset = promptBarModel(
      input({ activePreset: gameAgent, presetLabel: (name) => `Acer ${name}` }),
    ).headerChips.at(-1)
    expect(preset).toMatchObject({ kind: 'preset', name: 'Game Agent', label: 'Acer Game Agent' })
  })

  it('labels a device by its short name and kind', () => {
    const devices = [
      { id: 'NPU', name: 'Intel(R) AI Boost', selected: true },
      { id: 'CPU', name: 'CPU', selected: true },
      { id: 'GPU.0', name: 'Intel(R) Arc(TM) Pro B60 Graphics', selected: true },
    ]
    const labels = devices.map(
      (device) =>
        promptBarModel(input({ machine: { chatBackend: 'openVINO', device } })).headerChips.find(
          (c): c is DeviceChip => c.kind === 'device',
        )?.label,
    )
    expect(labels).toEqual(['AI Boost NPU', 'CPU', 'Arc Pro B60 GPU'])
  })

  it('shows no chat backend or chat model for a speech preset', () => {
    const tts = { ...assistant, name: 'Text to Speech', category: 'audio', ttsPreset: true }
    const { headerChips } = promptBarModel(
      input({
        activePreset: tts,
        machine: { chatBackend: 'llamaCPP', chatModel: 'Qwen3.5-9B-Q4_K_M.gguf', device: gpu },
      }),
    )
    expect(headerChips.map((c) => c.kind)).toEqual(['device', 'preset'])
  })
})

describe('promptBarModel modes', () => {
  const chat = (name: string, extra: Partial<ChatPreset> = {}): ChatPreset => ({
    ...assistant,
    name,
    ...extra,
  })
  const agent = (name: string) => chat(name, { agentPreset: true })
  const audio = (name: string) => chat(name, { category: 'audio' })
  const image = (name: string, category = 'create-images'): Preset => ({
    ...comfy(name, []),
    category,
  })
  const names = (presets: Preset[]) => presets.map((p) => p.name)

  it('lists Agent Presets under Agent and never under Chat', () => {
    const catalog = [chat('Assistant'), agent('Agent'), agent('Game Agent'), agent('Quick Coder')]
    expect(names(presetsInMode(catalog, 'agent'))).toEqual(['Agent', 'Game Agent', 'Quick Coder'])
    expect(names(presetsInMode(catalog, 'chat'))).toEqual(['Assistant'])
  })

  it('keeps aiDAPTIV, Home Agent chat and user chat presets under Chat', () => {
    const catalog = [
      chat('Assistant'),
      chat('aiDAPTIV', { requiresPhison: true }),
      chat('Home Agent'),
      chat('My Helper', { category: undefined }),
    ]
    expect(names(presetsInMode(catalog, 'chat'))).toEqual([
      'Assistant',
      'aiDAPTIV',
      'Home Agent',
      'My Helper',
    ])
  })

  it('lists the speech presets under Audio', () => {
    const catalog = [chat('Assistant'), audio('Text to Speech'), audio('Speech to Text')]
    expect(names(presetsInMode(catalog, 'audio'))).toEqual(['Text to Speech', 'Speech to Text'])
    expect(names(presetsInMode(catalog, 'chat'))).toEqual(['Assistant'])
  })

  it('offers the six modes in order, leaving out modes with no presets', () => {
    const all = [
      image('Video', 'create-videos'),
      image('Edit', 'edit-images'),
      image('Fast'),
      audio('Text to Speech'),
      agent('Game Agent'),
      chat('Assistant'),
    ]
    expect(promptBarModel(input({ catalog: all })).modes).toEqual([
      'chat',
      'agent',
      'audio',
      'imageGen',
      'imageEdit',
      'video',
    ])
    expect(promptBarModel(input({ catalog: [chat('Assistant'), image('Fast')] })).modes).toEqual([
      'chat',
      'imageGen',
    ])
  })

  it('selects the mode of the active preset, Agent for an Agent Preset', () => {
    const modeOf = (activePreset: Preset | null) =>
      promptBarModel(input({ activePreset })).activeMode
    expect(modeOf(agent('Game Agent'))).toBe('agent')
    expect(modeOf(chat('Assistant'))).toBe('chat')
    expect(modeOf(image('Edit', 'edit-images'))).toBe('imageEdit')
    expect(modeOf(null)).toBeNull()
  })

  describe('picking a mode', () => {
    const catalog = [
      chat('Assistant'),
      chat('Reasoning'),
      agent('Agent'),
      agent('Game Agent'),
      image('Fast'),
    ]
    const picks = (lastUsed: PromptBarInput['lastUsed']) =>
      promptBarModel(input({ catalog, lastUsed })).modePicks

    it('activates the mode’s last-used preset', () => {
      expect(picks({ agent: ['Game Agent'], chat: ['Reasoning'] })).toMatchObject({
        agent: 'Game Agent',
        chat: 'Reasoning',
      })
    })

    it('skips a remembered preset that belongs to another mode', () => {
      // The chat category remembers agent presets too; Chat must not land on one.
      expect(picks({ chat: [undefined, 'Game Agent', 'Reasoning'] }).chat).toBe('Reasoning')
    })

    it('falls back to the first preset when the last-used one left the catalog', () => {
      expect(picks({ agent: ['Removed Agent'], chat: [null] })).toMatchObject({
        agent: 'Agent',
        chat: 'Assistant',
      })
    })

    it('offers no pick for a mode without presets', () => {
      expect(picks({ video: ['Fast'] })).toEqual({
        chat: 'Assistant',
        agent: 'Agent',
        imageGen: 'Fast',
      })
    })
  })
})

describe('promptBarModel preset picker', () => {
  const chat = (name: string, extra: Partial<ChatPreset> = {}): ChatPreset => ({
    ...assistant,
    name,
    image: `${name}.png`,
    ...extra,
  })
  const agent = (name: string) => chat(name, { agentPreset: true })
  const gameAgent = agent('Game Agent')
  const catalog: Preset[] = [
    chat('Assistant'),
    chat('aiDAPTIV', { requiresPhison: true }),
    chat('Home Agent'),
    agent('Agent'),
    gameAgent,
    agent('Quick Coder'),
    { ...comfy('Fast', []), image: 'fast.png' },
  ]

  it('lists the active mode’s presets with branded label and thumbnail', () => {
    const { presets } = promptBarModel(
      input({
        catalog,
        activePreset: gameAgent,
        presetLabel: (name) => (name === 'Game Agent' ? `Acer ${name}` : name),
      }),
    )
    expect(presets).toEqual([
      { name: 'Agent', label: 'Agent', image: 'Agent.png', enabled: true },
      { name: 'Game Agent', label: 'Acer Game Agent', image: 'Game Agent.png', enabled: true },
      { name: 'Quick Coder', label: 'Quick Coder', image: 'Quick Coder.png', enabled: true },
    ])
  })

  it('keeps gated presets listed but disabled, with the reason', () => {
    const { presets } = promptBarModel(
      input({
        catalog,
        presetGate: (preset) =>
          preset.name === 'Home Agent'
            ? { enabled: false, reason: 'Enable the Home Agent in settings to use this preset.' }
            : { enabled: true },
      }),
    )
    expect(presets.map(({ name, enabled, reason }) => ({ name, enabled, reason }))).toEqual([
      { name: 'Assistant', enabled: true, reason: undefined },
      { name: 'aiDAPTIV', enabled: true, reason: undefined },
      {
        name: 'Home Agent',
        enabled: false,
        reason: 'Enable the Home Agent in settings to use this preset.',
      },
    ])
  })

  describe('the header preset chip', () => {
    const chipFor = (activePreset: Preset, style: PromptBarInput['style']) =>
      promptBarModel(input({ catalog, activePreset, style })).presetChip

    it('is a dropdown in Modern when the mode has several presets', () => {
      expect(chipFor(gameAgent, 'modern')).toBe('dropdown')
    })

    it('is a label in Modern when the mode has a single preset', () => {
      expect(chipFor(catalog[6], 'modern')).toBe('label')
    })

    it('is always a label in Classic', () => {
      expect(chipFor(gameAgent, 'classic')).toBe('label')
    })
  })
})
