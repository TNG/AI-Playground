import { describe, expect, it } from 'vitest'
import { promptBarModel, type DeviceChip, type PromptBarInput } from '@/lib/promptBarModel'
import type { ChatPreset, ComfyUiPreset } from '@/lib/presetSchemas'

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
