import { describe, expect, it } from 'vitest'
import {
  agentList,
  lastUsedByMode,
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

  describe('a speech preset', () => {
    const tts = { ...assistant, name: 'Text to Speech', category: 'audio', ttsPreset: true }
    const stt = { ...assistant, name: 'Speech to Text', category: 'audio', sttPreset: true }
    const chipsFor = (preset: ChatPreset, machine: Partial<PromptBarInput['machine']>) =>
      promptBarModel(
        input({
          activePreset: preset,
          machine: { chatBackend: 'llamaCPP', chatModel: 'Qwen3.5-9B-Q4_K_M.gguf', ...machine },
        }),
      ).headerChips

    it('names its speech engine and device instead of the chat backend and model', () => {
      expect(chipsFor(tts, { speechBackend: 'qwen3TTS', device: gpu }).slice(0, 2)).toEqual([
        { kind: 'backend', backend: 'qwen3TTS' },
        expect.objectContaining({ kind: 'device', label: 'Arc B580 GPU' }),
      ])
      expect(chipsFor(stt, { speechBackend: 'openVINO', device: gpu }).map((c) => c.kind)).toEqual([
        'backend',
        'device',
        'preset',
      ])
    })

    it('shows no local device on an external speech endpoint', () => {
      expect(chipsFor(tts, { speechBackend: 'external' }).map((c) => c.kind)).toEqual([
        'backend',
        'preset',
      ])
    })
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

  it('lists Assistant under Chat though it runs on the harness, the other harness presets under Agent', () => {
    const catalog = [
      chat('aiDAPTIV'),
      agent('Assistant'),
      agent('Game Agent'),
      agent('Quick Coder'),
    ]
    expect(names(presetsInMode(catalog, 'agent'))).toEqual(['Game Agent', 'Quick Coder'])
    expect(names(presetsInMode(catalog, 'chat'))).toEqual(['aiDAPTIV', 'Assistant'])
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

  it('selects the mode the active preset is listed under', () => {
    const modeOf = (activePreset: Preset | null) =>
      promptBarModel(input({ activePreset })).activeMode
    expect(modeOf(agent('Game Agent'))).toBe('agent')
    expect(modeOf(agent('Assistant'))).toBe('chat')
    expect(modeOf(chat('aiDAPTIV'))).toBe('chat')
    expect(modeOf(image('Edit', 'edit-images'))).toBe('imageEdit')
    expect(modeOf(null)).toBeNull()
  })

  describe('picking a mode', () => {
    const catalog = [
      chat('Plain Chat'),
      chat('Reasoning'),
      agent('Assistant'),
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
      expect(picks({ agent: ['Removed Agent'], chat: ['Removed Chat'] })).toMatchObject({
        agent: 'Game Agent',
        chat: 'Assistant',
      })
    })

    it('falls back to Assistant for Chat mode, wherever it sits in the catalog', () => {
      const reordered = [chat('Plain Chat'), agent('Game Agent'), agent('Assistant')]
      expect(promptBarModel(input({ catalog: reordered })).modePicks.chat).toBe('Assistant')
    })

    it('never picks a gated preset, falling back to the mode’s first enabled one', () => {
      const gated = new Set(['Plain Chat', 'Reasoning', 'Assistant'])
      const modePicks = promptBarModel(
        input({
          catalog: [chat('Home Agent'), ...catalog],
          lastUsed: { chat: ['Reasoning'] },
          presetGate: (preset) =>
            gated.has(preset.name)
              ? { enabled: false, reason: 'PRESET_GATE_HOME_AGENT_DISABLED' }
              : { enabled: true },
        }),
      ).modePicks
      expect(modePicks).toMatchObject({ chat: 'Home Agent', agent: 'Game Agent' })
    })

    it('offers no pick for a mode whose presets are all gated', () => {
      const modePicks = promptBarModel(
        input({
          catalog,
          presetGate: (preset) =>
            preset.type === 'comfy'
              ? { enabled: false, reason: 'PRESET_GATE_PHISON' }
              : { enabled: true },
        }),
      ).modePicks
      expect(modePicks.imageGen).toBeUndefined()
    })

    it('offers no pick for a mode without presets', () => {
      expect(picks({ video: ['Fast'] })).toEqual({
        chat: 'Assistant',
        agent: 'Game Agent',
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
    chat('Plain Chat'),
    chat('aiDAPTIV', { requiresPhison: true }),
    chat('Home Agent'),
    agent('Assistant'),
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
            ? { enabled: false, reason: 'PRESET_GATE_HOME_AGENT_DISABLED' }
            : { enabled: true },
      }),
    )
    expect(presets.map(({ name, enabled, reason }) => ({ name, enabled, reason }))).toEqual([
      { name: 'Plain Chat', enabled: true, reason: undefined },
      { name: 'aiDAPTIV', enabled: true, reason: undefined },
      { name: 'Home Agent', enabled: false, reason: 'PRESET_GATE_HOME_AGENT_DISABLED' },
      { name: 'Assistant', enabled: true, reason: undefined },
    ])
  })

  describe('the Agents of the agent dropdown', () => {
    const assistant = catalog[3]
    const digest = {
      id: 'a-digest',
      name: 'Morning digest',
      description: 'Reads the news',
      image: 'digest.png',
      saved: true,
    }
    const draftOnly = { id: 'a-new', name: 'Unsaved idea', saved: false }
    const tidy = { id: 'a-tidy', name: 'Tidy downloads', saved: true }

    it('come after the agent presets as their own group, saved Agents only', () => {
      const model = promptBarModel(
        input({ catalog, activePreset: gameAgent, agents: [digest, draftOnly, tidy] }),
      )
      expect(model.presets.map((preset) => preset.name)).toEqual(['Game Agent', 'Quick Coder'])
      expect(model.agents).toEqual([
        {
          id: 'a-digest',
          name: 'Morning digest',
          description: 'Reads the news',
          image: 'digest.png',
        },
        { id: 'a-tidy', name: 'Tidy downloads' },
      ])
    })

    it('are not listed under Chat, Assistant included', () => {
      const model = promptBarModel(input({ catalog, activePreset: assistant, agents: [digest] }))
      expect(model.activeMode).toBe('chat')
      expect(model.agents).toEqual([])
    })

    it('keep the Agent mode while a picked Agent runs on Assistant', () => {
      const model = promptBarModel(
        input({ catalog, activePreset: assistant, agents: [digest], pickedAgentId: 'a-digest' }),
      )
      expect(model.activeMode).toBe('agent')
      expect(model.presets.map((preset) => preset.name)).toEqual(['Game Agent', 'Quick Coder'])
      expect(model.agents.map((agent) => agent.id)).toEqual(['a-digest'])
    })

    it('show a picked Agent on the header chip, by its current name and image', () => {
      const model = promptBarModel(
        input({ catalog, activePreset: assistant, agents: [digest], pickedAgentId: 'a-digest' }),
      )
      expect(model.pickedAgent).toEqual({
        id: 'a-digest',
        name: 'Morning digest',
        description: 'Reads the news',
        image: 'digest.png',
      })
      expect(model.headerChips.at(-1)).toEqual({
        kind: 'preset',
        name: 'Assistant',
        label: 'Morning digest',
        image: 'digest.png',
        agentId: 'a-digest',
      })
    })

    it('leave the pick out of effect under another Agent Preset', () => {
      const model = promptBarModel(
        input({ catalog, activePreset: gameAgent, agents: [digest], pickedAgentId: 'a-digest' }),
      )
      expect(model.pickedAgent).toBeUndefined()
      expect(model.headerChips.at(-1)).toMatchObject({ kind: 'preset', label: 'Game Agent' })
    })

    it('fall back to Agent Maker when the picked Agent is gone or only a Draft', () => {
      for (const pickedAgentId of ['a-deleted', 'a-new']) {
        const model = promptBarModel(
          input({ catalog, activePreset: assistant, agents: [draftOnly], pickedAgentId }),
        )
        expect(model.pickedAgent).toBeUndefined()
        expect(model.headerChips.at(-1)).toEqual({
          kind: 'preset',
          name: 'Assistant',
          label: 'Assistant',
          image: 'Assistant.png',
        })
      }
    })
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

describe('agentList', () => {
  const named = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: `a-${i + 1}`, name: `Agent ${i + 1}` }))

  it('offers no filter for 8 Agents or fewer, and lists them all whatever was typed', () => {
    const list = agentList(named(8), 'Agent 3')
    expect(list.filterable).toBe(false)
    expect(list.agents).toHaveLength(8)
  })

  it('offers a filter once there are more than 8 Agents', () => {
    const list = agentList(named(9), '')
    expect(list.filterable).toBe(true)
    expect(list.agents).toHaveLength(9)
  })

  it('narrows a long list by name or description, ignoring case and surrounding spaces', () => {
    const agents = [
      ...named(8),
      { id: 'a-digest', name: 'Morning Digest', description: 'Reads the news' },
      { id: 'a-tidy', name: 'Tidy downloads', description: 'Sorts the DIGEST folder' },
    ]
    expect(agentList(agents, '  digest ').agents.map((agent) => agent.id)).toEqual([
      'a-digest',
      'a-tidy',
    ])
    expect(agentList(agents, 'NEWS').agents.map((agent) => agent.id)).toEqual(['a-digest'])
  })

  it('lists nothing when no Agent matches', () => {
    const list = agentList(named(9), 'weather')
    expect(list.filterable).toBe(true)
    expect(list.agents).toEqual([])
  })
})

describe('lastUsedByMode', () => {
  it('puts the mode’s own memory ahead of its category’s', () => {
    const lastUsed = lastUsedByMode(
      { agent: 'Game Agent', imageGen: 'Fast' },
      { chat: 'Reasoning', 'create-images': 'HD Image', audio: 'Text to Speech' },
    )
    expect(lastUsed).toMatchObject({
      chat: [undefined, 'Reasoning'],
      agent: ['Game Agent', 'Reasoning'],
      audio: [undefined, 'Text to Speech'],
      imageGen: ['Fast', 'HD Image'],
      video: [undefined, undefined],
    })
  })
})

describe('promptBarModel capture buttons', () => {
  const chat = (name: string, extra: Partial<ChatPreset> = {}) =>
    ({ ...assistant, name, ...extra }) as ChatPreset
  const captureFor = (activePreset: Preset | null) =>
    promptBarModel(input({ activePreset })).capture

  it('shows mic and camera for Assistant on the agent harness', () => {
    expect(captureFor(chat('Assistant', { agentPreset: true }))).toBe(true)
  })

  it('shows them for a plain chat preset', () => {
    expect(captureFor(chat('aiDAPTIV'))).toBe(true)
  })

  it('keeps them off Game Agent, Quick Coder, the speech presets and the media modes', () => {
    expect(captureFor(chat('Game Agent', { agentPreset: true }))).toBe(false)
    expect(captureFor(chat('Quick Coder', { agentPreset: true }))).toBe(false)
    expect(captureFor(chat('Text to Speech', { category: 'audio', ttsPreset: true }))).toBe(false)
    expect(captureFor(comfy('Fast', []))).toBe(false)
    expect(captureFor(null)).toBe(false)
  })
})
