import { describe, expect, it } from 'vitest'
import {
  agentRunModelGap,
  agentRunModelGapAnswer,
  agentRunModelGapMessage,
  agentSessionNeedsTools,
  catalogModelToolUse,
  gateCapabilityCatalog,
} from '@/lib/modelToolUse'

const catalog = ['files', 'media', 'rag', 'web', 'memory'].map((id) => ({
  id,
  label: id,
  summary: '',
  requires: [],
  commands: [],
}))

const text = (key: string) => `<${key}>`

const reasons = (entries: { id: string; unavailableReason?: string }[]) =>
  Object.fromEntries(entries.map((entry) => [entry.id, entry.unavailableReason]))

describe('gateCapabilityCatalog', () => {
  it('disables file and shell editing, with a reason, for a model not suited to agent work', () => {
    const use = catalogModelToolUse('llamaCPP', { supportsToolCalling: true })
    expect(reasons(gateCapabilityCatalog(catalog, use, text))).toEqual({
      files: '<AGENT_CAPABILITY_NOT_AGENTIC>',
      media: undefined,
      rag: undefined,
      web: undefined,
      memory: undefined,
    })
  })

  it('leaves everything on offer for an agentic model and for cloud', () => {
    const agentic = catalogModelToolUse('openVINO', {
      supportsToolCalling: true,
      supportsAgentic: true,
    })
    expect(Object.values(reasons(gateCapabilityCatalog(catalog, agentic, text)))).toEqual(
      catalog.map(() => undefined),
    )
    const cloud = catalogModelToolUse('cloud', undefined)
    expect(Object.values(reasons(gateCapabilityCatalog(catalog, cloud, text)))).toEqual(
      catalog.map(() => undefined),
    )
  })

  it('disables every capability for an untagged user-added model, which gets no tools', () => {
    const use = catalogModelToolUse('llamaCPP', {})
    for (const reason of Object.values(reasons(gateCapabilityCatalog(catalog, use, text)))) {
      expect(reason).toBe('<AGENT_CAPABILITY_NO_TOOL_CALLING>')
    }
  })

  it("keeps main's own reason when it has one", () => {
    const withReason = [{ ...catalog[0], unavailableReason: 'Not here.' }]
    const use = catalogModelToolUse('llamaCPP', { supportsToolCalling: true })
    expect(gateCapabilityCatalog(withReason, use, text)[0].unavailableReason).toBe('Not here.')
  })
})

describe('agentRunModelGap', () => {
  const capable = { supportsToolCalling: true, supportsAgentic: true }
  const toolsy = { capabilities: ['media', 'web'], presetOwnsPrompt: true }

  it('passes a capable model, and a cloud model nobody ruled out', () => {
    expect(agentRunModelGap({ backend: 'llamaCPP', activeLlmModel: capable, ...toolsy })).toBeNull()
    // Cloud stays assumed capable: no flags, no gap.
    expect(agentRunModelGap({ backend: 'cloud', activeLlmModel: null, ...toolsy })).toBeNull()
  })

  it('gates a cloud model the provider or the user ruled out', () => {
    expect(
      agentRunModelGap({
        backend: 'cloud',
        activeLlmModel: { supportsToolCalling: true, supportsAgentic: false },
        ...toolsy,
      }),
    ).toBe('agentic')
    expect(
      agentRunModelGap({
        backend: 'cloud',
        activeLlmModel: { supportsToolCalling: false, supportsAgentic: true },
        ...toolsy,
      }),
    ).toBe('toolCalling')
    // Unconditional like the local gate, even for a toolless session.
    expect(
      agentRunModelGap({
        backend: 'cloud',
        activeLlmModel: { supportsAgentic: false },
        capabilities: [],
        presetOwnsPrompt: true,
      }),
    ).toBe('agentic')
  })

  it('refuses a non-agentic model on every agent run', () => {
    // Unconditional: even a session that would lose nothing is refused.
    expect(
      agentRunModelGap({
        backend: 'llamaCPP',
        activeLlmModel: { supportsToolCalling: true },
        capabilities: [],
        presetOwnsPrompt: true,
      }),
    ).toBe('agentic')
  })

  it('refuses a model without tool calling only when the session would have tools', () => {
    expect(agentRunModelGap({ backend: 'llamaCPP', activeLlmModel: {}, ...toolsy })).toBe(
      'toolCalling',
    )
    // An unset flag is not granted, like the picker's requiresAgentic gate.
    expect(agentRunModelGap({ backend: 'llamaCPP', activeLlmModel: null, ...toolsy })).toBe(
      'toolCalling',
    )
    // Toolless owned-prompt session (memory only): the gap is not relevant.
    expect(
      agentRunModelGap({
        backend: 'llamaCPP',
        activeLlmModel: {},
        capabilities: ['memory'],
        presetOwnsPrompt: true,
      }),
    ).toBeNull()
  })

  it('treats every attached MCP server as tools', () => {
    expect(
      agentRunModelGap({
        backend: 'llamaCPP',
        activeLlmModel: {},
        capabilities: ['mcp:blender'],
        presetOwnsPrompt: true,
      }),
    ).toBe('toolCalling')
  })
})

describe('catalogModelToolUse', () => {
  it('keeps cloud assumed capable until a flag explicitly rules the model out', () => {
    expect(catalogModelToolUse('cloud', undefined)).toEqual({
      toolCalling: true,
      agentic: true,
    })
    expect(catalogModelToolUse('cloud', {})).toEqual({ toolCalling: true, agentic: true })
    expect(catalogModelToolUse('cloud', { supportsToolCalling: false })).toEqual({
      toolCalling: false,
      agentic: true,
    })
    expect(catalogModelToolUse('cloud', { supportsAgentic: false })).toEqual({
      toolCalling: true,
      agentic: false,
    })
  })

  it('keeps a local backend strict: nothing is granted but an explicit true', () => {
    expect(catalogModelToolUse('llamaCPP', undefined)).toEqual({
      toolCalling: false,
      agentic: false,
    })
    expect(catalogModelToolUse('llamaCPP', {})).toEqual({
      toolCalling: false,
      agentic: false,
    })
    expect(catalogModelToolUse('llamaCPP', { supportsToolCalling: true })).toEqual({
      toolCalling: true,
      agentic: false,
    })
  })
})

describe('agentSessionNeedsTools', () => {
  it('is true for every custom-prompt session, which keeps the core builtins', () => {
    expect(agentSessionNeedsTools([], false)).toBe(true)
  })

  it('is false for an owned-prompt session with nothing tool-carrying enabled', () => {
    expect(agentSessionNeedsTools(['memory'], true)).toBe(false)
    expect(agentSessionNeedsTools([], true)).toBe(false)
  })

  it('counts the tool-carrying capabilities and attached MCP servers', () => {
    for (const id of [
      'files',
      'media',
      'rag',
      'web',
      'web-screenshot',
      'web-debug',
      'notify',
      'overview',
      'game-studio',
      'game-studio-quick',
    ]) {
      expect(agentSessionNeedsTools([id], true)).toBe(true)
    }
    expect(agentSessionNeedsTools(['mcp:anything'], true)).toBe(true)
  })
})

describe('agentRunModelGapMessage', () => {
  it('fills the model into the active locale message, with a fallback', () => {
    const toolCalling = agentRunModelGapMessage('toolCalling', 'Qwen3-9B', {})
    expect(toolCalling).toContain('Qwen3-9B')
    expect(toolCalling).toContain('cannot call tools')
    const agentic = agentRunModelGapMessage('agentic', 'Qwen3-9B', {
      AGENT_RUN_MODEL_NOT_AGENTIC: 'Not started: {model} is not agentic here.',
    })
    expect(agentic).toBe('Not started: Qwen3-9B is not agentic here.')
  })
})

describe('agentRunModelGapAnswer', () => {
  it('answers with the switch-model sentence, without the "Not started:" lead', () => {
    const agentic = agentRunModelGapAnswer('agentic', 'Qwen3-9B', {})
    expect(agentic).toContain('Qwen3-9B')
    expect(agentic).toContain('not agentic')
    expect(agentic).toContain('Switch to an agentic-capable model')
    expect(agentic).not.toContain('Not started')
    const toolCalling = agentRunModelGapAnswer('toolCalling', 'Qwen3-9B', {
      AGENT_RUN_MODEL_NOT_TOOL_CALLING_ANSWER: '{model} cannot call tools here.',
    })
    expect(toolCalling).toBe('Qwen3-9B cannot call tools here.')
  })
})
