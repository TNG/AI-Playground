import { describe, it, expect } from 'vitest'
import { toolAvailabilitySection, withToolAvailability } from './toolAvailabilityPrompt'
import type { ToolAvailabilityInput } from './toolAvailabilityPrompt'

/** Everything on and available: the fully-enabled baseline (empty section). */
function baseInput(overrides: Partial<ToolAvailabilityInput> = {}): ToolAvailabilityInput {
  return {
    surface: 'chat',
    modelSupportsToolCalling: true,
    builtinToolsEnabled: true,
    isToolEnabled: () => true,
    delegationEnabled: true,
    modelSupportsVision: true,
    generateWorkflowsAvailable: true,
    editWorkflowsAvailable: true,
    screenshotWindowSelected: true,
    ttsAvailable: true,
    transcriptionAvailable: true,
    mcpEnabled: true,
    mcpServers: [],
    mcpSelectedIds: [],
    ...overrides,
  }
}

describe('toolAvailabilitySection', () => {
  it('says nothing when every tool is available and every server is in use', () => {
    expect(toolAvailabilitySection(baseInput())).toBe('')
  })

  it('explains that a model without tool calling can use no tools at all', () => {
    const section = toolAvailabilitySection(baseInput({ modelSupportsToolCalling: false }))
    expect(section).toContain('does not support tool calling')
    expect(section).toContain('media generation')
    expect(section).toContain('tell them the app supports it')
  })

  it('lists a disabled tool with its description, reason and the directive', () => {
    const section = toolAvailabilitySection(
      baseInput({ isToolEnabled: (name) => name !== 'browseWeb' }),
    )
    expect(section).toContain('Tool availability:')
    expect(section).toContain('Tools you can call right now:')
    expect(section).toContain('Browse the web')
    expect(section).toContain(
      "disabled — the user can enable it in the preset's Built-in tools settings",
    )
  })

  it('leads with the do-not-decline directive whenever it says anything', () => {
    const section = toolAvailabilitySection(baseInput({ ttsAvailable: false }))
    const [heading, directive] = section.split('\n')
    expect(heading).toBe('Tool availability:')
    expect(directive).toContain('do not just say you cannot do it')
  })

  it('counts every tool as unavailable when the master switch is off', () => {
    const section = toolAvailabilitySection(baseInput({ builtinToolsEnabled: false }))
    expect(section).toContain('built-in tools are turned off for this preset')
    expect(section).not.toContain('Tools you can call right now:')
  })

  it('gives the screenshot tool its vision and window reasons', () => {
    const noVision = toolAvailabilitySection(
      baseInput({
        modelSupportsVision: false,
      }),
    )
    expect(noVision).toContain('Capture screenshot')
    expect(noVision).toContain('requires a vision-capable model')

    const noWindow = toolAvailabilitySection(
      baseInput({
        modelSupportsVision: true,
        screenshotWindowSelected: false,
      }),
    )
    expect(noWindow).toContain('requires a window to be selected for capture')
  })

  it('names missing speech engines as the reason', () => {
    const section = toolAvailabilitySection(baseInput({ ttsAvailable: false }))
    expect(section).toContain('Text To Speech')
    expect(section).toContain('no text-to-speech engine is configured')

    const stt = toolAvailabilitySection(baseInput({ transcriptionAvailable: false }))
    expect(stt).toContain('Speech To Text')
    expect(stt).toContain('no speech-to-text engine is available')
  })

  describe('media delegation', () => {
    it('reports the comfy pair as one available media tool when delegation covers it', () => {
      const section = toolAvailabilitySection(baseInput())
      // Fully enabled: nothing to say at all.
      expect(section).toBe('')
    })

    it('folds the pair into one unavailable entry when no workflow is left', () => {
      const section = toolAvailabilitySection(
        baseInput({ generateWorkflowsAvailable: false, editWorkflowsAvailable: false }),
      )
      expect(section).toContain('Media generation')
      expect(section).toContain('no workflows are enabled for them')
      expect(section).not.toContain('Generate media:')
    })

    it('says the media tools are disabled when both toggles are off', () => {
      const section = toolAvailabilitySection(
        baseInput({ isToolEnabled: (name) => name !== 'comfyUI' && name !== 'comfyUiImageEdit' }),
      )
      expect(section).toContain('Media generation')
      expect(section).toContain(
        "disabled — the user can enable it in the preset's Built-in tools settings",
      )
    })

    it('lists the two comfy tools separately when delegation is off', () => {
      const section = toolAvailabilitySection(
        baseInput({
          delegationEnabled: false,
          isToolEnabled: (name) => name !== 'comfyUI',
        }),
      )
      expect(section).toContain('Generate media')
      expect(section).toContain('disabled — the user can enable it')
      // The edit tool stays available and is not called unavailable.
      expect(section).not.toContain('Transform image:')
    })

    it('keeps the pair available when only one branch has workflows', () => {
      const section = toolAvailabilitySection(baseInput({ generateWorkflowsAvailable: false }))
      expect(section).not.toContain('Media generation:')
    })
  })

  describe('MCP servers', () => {
    const servers = [
      { id: 'files', name: 'Files' },
      { id: 'weather', name: 'Weather' },
    ]

    it('names selected servers as available', () => {
      const section = toolAvailabilitySection(
        baseInput({
          mcpServers: servers,
          mcpSelectedIds: ['weather'],
          isToolEnabled: () => false,
        }),
      )
      expect(section).toContain('MCP server Weather')
      expect(section).toContain('MCP server Files')
    })

    it('lists a configured server that is not selected for the preset', () => {
      const section = toolAvailabilitySection(
        baseInput({
          mcpServers: servers,
          mcpSelectedIds: ['weather'],
          isToolEnabled: () => false,
        }),
      )
      expect(section).toContain('configured but not selected for this preset')
    })

    it('reports MCP tools turned off for the preset as one entry', () => {
      const section = toolAvailabilitySection(
        baseInput({
          mcpServers: servers,
          mcpEnabled: false,
          mcpSelectedIds: [],
          isToolEnabled: () => false,
        }),
      )
      expect(section).toContain('MCP tools are turned off for this preset')
      expect(section).not.toContain('not selected for this preset')
    })
  })

  describe('agent surface', () => {
    it('leaves the chat-only tools out entirely', () => {
      const section = toolAvailabilitySection(
        baseInput({ surface: 'agent', isToolEnabled: () => false, mcpServers: [] }),
      )
      expect(section).not.toContain('Browse the web')
      expect(section).not.toContain('Visualize detections')
      expect(section).toContain('Media generation')
    })

    it('blames the media capability when it is off for the session', () => {
      const section = toolAvailabilitySection(
        baseInput({ surface: 'agent', mediaCapabilityEnabled: false }),
      )
      expect(section).toContain('the Media generation capability is turned off for this session')
    })

    it('points at the session settings and names an unattached server', () => {
      const section = toolAvailabilitySection(
        baseInput({
          surface: 'agent',
          isToolEnabled: () => false,
          mcpServers: [{ id: 'files', name: 'Files' }],
          mcpSelectedIds: [],
        }),
      )
      expect(section).toContain(
        "disabled — the user can enable it in the session's media tools settings",
      )
      expect(section).toContain('configured but not attached to this session')
    })
  })
})

describe('withToolAvailability', () => {
  it('appends the section after the prompt', () => {
    expect(withToolAvailability('You are helpful.', 'Tool availability: none')).toBe(
      'You are helpful.\n\nTool availability: none',
    )
  })

  it('uses the section alone when the prompt is empty', () => {
    expect(withToolAvailability('', 'Tool availability: none')).toBe('Tool availability: none')
  })

  it('adds nothing without a section', () => {
    expect(withToolAvailability('You are helpful.', '')).toBe('You are helpful.')
    expect(withToolAvailability('', '')).toBe('')
  })
})
