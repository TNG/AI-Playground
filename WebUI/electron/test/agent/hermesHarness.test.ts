import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import type { StreamChunk } from '../../agent/piStreamTranslate'
import { createHermesStreamTranslator } from '../../agent/hermes/hermesStreamTranslate'
import { buildHermesConfig } from '../../adapters/backends/hermesConfig'
import {
  gateCatalogForHarness,
  hermesContextSize,
  hermesFileTools,
  hermesInstalled,
  hermesSupportsCapability,
  sessionHarness,
} from '@/lib/agentHarness'
import { agentFooter, answeredByHermes } from '@/lib/turnFooter'
import {
  applySessionPresetNames,
  HERMES_PREVIEW_PRESET,
  type AgentSessionRecord,
} from '@/assets/js/store/agentModeSessions'

describe('which harness a turn runs on', () => {
  it('takes the Session setting over the preset, and Pi when neither says', () => {
    expect(sessionHarness({ harness: 'hermes' }, { harness: 'pi' })).toBe('hermes')
    expect(sessionHarness({}, { harness: 'hermes' })).toBe('hermes')
    expect(sessionHarness(null)).toBe('pi')
  })

  it('offers Hermes only once its sidecar is installed', () => {
    expect(hermesInstalled([{ serviceName: 'hermes-backend', isSetUp: false }])).toBe(false)
    expect(hermesInstalled([{ serviceName: 'hermes-backend', isSetUp: true }])).toBe(true)
  })
})

describe('the window a Hermes turn gets', () => {
  it('raises to 64k, but never past what the model holds and never down', () => {
    expect(hermesContextSize(32768)).toBe(64000)
    expect(hermesContextSize(32768, 262144)).toBe(64000)
    expect(hermesContextSize(32768, 40960)).toBe(40960)
    expect(hermesContextSize(1024, 1024)).toBe(1024)
    expect(hermesContextSize(131072, 262144)).toBe(131072)
  })
})

describe('capabilities on Hermes', () => {
  it('bridges tool capabilities and leaves Pi extensions and game sessions out', () => {
    for (const id of ['media', 'rag', 'web', 'notify', 'mcp:github']) {
      expect(hermesSupportsCapability(id)).toBe(true)
    }
    for (const id of ['memory', 'web-debug', 'game-studio', 'game-studio-quick']) {
      expect(hermesSupportsCapability(id)).toBe(false)
    }
  })

  it('marks the unsupported ones unavailable without overwriting a model gate', () => {
    const catalog = [
      { id: 'media' },
      { id: 'memory' },
      { id: 'web-debug', unavailableReason: 'needs vision' },
    ]
    expect(gateCatalogForHarness(catalog, 'pi', 'no')).toEqual(catalog)
    expect(gateCatalogForHarness(catalog, 'hermes', 'not on Hermes')).toEqual([
      { id: 'media' },
      { id: 'memory', unavailableReason: 'not on Hermes' },
      { id: 'web-debug', unavailableReason: 'needs vision' },
    ])
  })

  it('keeps file tools exactly where Pi would', () => {
    expect(hermesFileTools({ capabilities: ['media'] })).toBe(true)
    expect(hermesFileTools({ ownsPrompt: true, capabilities: ['media'] })).toBe(false)
    expect(hermesFileTools({ ownsPrompt: true, capabilities: ['files', 'media'] })).toBe(true)
  })
})

describe('Hermes config toolsets', () => {
  const base = {
    llm: { url: 'http://127.0.0.1:1', key: 'k' },
    mcp: { url: 'http://127.0.0.1:2/mcp', key: 'm' },
    contextLength: 131072,
  }
  const toolsets = (fileTools?: boolean) =>
    (buildHermesConfig({ ...base, fileTools }).platform_toolsets as { api_server: string[] })
      .api_server

  it('gives the coding toolset unless file tools are off', () => {
    expect(toolsets()).toEqual(['hermes-acp', 'aipg'])
    expect(toolsets(true)).toEqual(['hermes-acp', 'aipg'])
    const without = toolsets(false)
    expect(without).toContain('aipg')
    expect(without).not.toContain('hermes-acp')
    expect(without).not.toContain('terminal')
    expect(without).not.toContain('file')
  })
})

describe('Hermes turns in the timeline', () => {
  it('stamps its answers so they can be told apart', () => {
    const chunks: StreamChunk[] = []
    const translator = createHermesStreamTranslator({
      emit: (chunk) => chunks.push(chunk),
      model: 'm',
      turnId: 't1',
    })
    translator.handle({ event: 'message.delta', delta: 'hi' })
    translator.finish()
    const start = chunks.find((chunk) => chunk.type === 'start')
    expect(start?.messageMetadata).toMatchObject({ harness: 'hermes', harnessTurnId: 't1' })
  })

  it('offers no Regenerate or Delete for a Hermes answer', () => {
    const answer = {
      id: 'a',
      role: 'assistant',
      parts: [],
      metadata: { harness: 'hermes', harnessTurnId: 't1' },
    } as UIMessage
    expect(answeredByHermes([answer])).toBe(true)
    const footer = agentFooter('hello', { answer, harnessTurn: undefined, latest: true })
    expect(footer.actions).toEqual(['copy', 'speak'])
  })
})

describe('retired Hermes Agent preset', () => {
  it('continues its sessions as Assistant Sessions on Hermes', () => {
    const record = {
      id: 's1',
      workspaceDir: '/tmp/ws',
      messages: [],
      presetName: HERMES_PREVIEW_PRESET,
      settings: { capabilities: ['media'] },
    } as unknown as AgentSessionRecord
    const migrated = applySessionPresetNames({ s1: record }, new Set())
    expect(migrated.s1.presetName).toBe('Assistant')
    expect(migrated.s1.settings).toEqual({ capabilities: ['media'], harness: 'hermes' })
  })
})
