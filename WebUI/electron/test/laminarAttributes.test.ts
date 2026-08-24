import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp',
    isPackaged: false,
    getAppPath: () => '/tmp',
  },
}))

const { stampSpanStart, setChatTraceContext, setAgentRunIdentity, clearAgentRunIdentity } =
  await import('../laminarAttributes.ts')

const METADATA = 'lmnr.association.properties.metadata.'
const HOST = `${METADATA}hostname`
const DEVICE = `${METADATA}device`
const DEVICE_NAME = `${METADATA}deviceName`
const PRESET = `${METADATA}preset`
const AGENT_TYPE = `${METADATA}agentType`
const CAPABILITIES = `${METADATA}capabilities`
const GAME = `${METADATA}game`
const GAME_ID = `${METADATA}gameId`

describe('stampSpanStart', () => {
  afterEach(() => setChatTraceContext(null))

  it('stamps hostname even without a turn context', () => {
    const span = { attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.attributes[HOST]).toBe(os.hostname())
  })

  it('stamps device id and name from the chat context', () => {
    setChatTraceContext({
      backend: 'llamaCPP',
      device: 'GPU.0',
      deviceName: 'Intel Arc B580',
    })
    const span = { name: 'ai.streamText', attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.attributes[HOST]).toBe(os.hostname())
    expect(span.attributes[DEVICE]).toBe('GPU.0')
    expect(span.attributes[DEVICE_NAME]).toBe('Intel Arc B580')
  })

  it('stamps the chat preset', () => {
    setChatTraceContext({ backend: 'llamaCPP', preset: 'Agentic Chat' })
    const span = { name: 'ai.streamText', attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.attributes[PRESET]).toBe('Agentic Chat')
  })
})

describe('agent run labels', () => {
  afterEach(() => clearAgentRunIdentity())

  const rootSpan = () => ({ name: 'pi agent run', attributes: {} as Record<string, unknown> })

  it('names the run after its preset and game, and stamps what it is', () => {
    setAgentRunIdentity(() => ({
      preset: 'Game Agent',
      type: 'game-agent',
      capabilities: 'game-studio, media, web-debug',
      appSession: 'aipg-agent-7',
      game: 'Asteroid Rush',
      gameId: 'asteroid-rush',
    }))
    const span = rootSpan()
    stampSpanStart(span)
    expect(span.name).toBe('Game Agent · Asteroid Rush')
    expect(span.attributes[PRESET]).toBe('Game Agent')
    expect(span.attributes[AGENT_TYPE]).toBe('game-agent')
    expect(span.attributes[CAPABILITIES]).toBe('game-studio, media, web-debug')
    expect(span.attributes[`${METADATA}appSession`]).toBe('aipg-agent-7')
    expect(span.attributes[GAME]).toBe('Asteroid Rush')
    expect(span.attributes[GAME_ID]).toBe('asteroid-rush')
  })

  it('falls back to the preset alone', () => {
    setAgentRunIdentity(() => ({ preset: 'Quick Coder', type: 'quick-coder' }))
    const span = rootSpan()
    stampSpanStart(span)
    expect(span.name).toBe('Quick Coder')
  })

  it('leaves the name alone when there is nothing to say', () => {
    setAgentRunIdentity(() => ({ type: 'agent' }))
    const span = rootSpan()
    stampSpanStart(span)
    expect(span.name).toBe('pi agent run')
    expect(span.attributes[AGENT_TYPE]).toBe('agent')
  })

  it('renames only the span Pi named', () => {
    setAgentRunIdentity(() => ({ preset: 'Game Agent', game: 'Asteroid Rush' }))
    const span = { name: 'LLM call (turn 2)', attributes: {} as Record<string, unknown> }
    stampSpanStart(span)
    expect(span.name).toBe('LLM call (turn 2)')
    expect(span.attributes[GAME]).toBe('Asteroid Rush')
  })

  it('leaves spans that have a parent to the trace they hang off', () => {
    setAgentRunIdentity(() => ({ preset: 'Game Agent' }))
    const span = {
      name: 'pi agent run',
      parentSpanId: 'abc',
      attributes: {} as Record<string, unknown>,
    }
    stampSpanStart(span)
    expect(span.name).toBe('pi agent run')
    expect(span.attributes[PRESET]).toBeUndefined()
  })

  it('re-reads the identity per span, so a game named mid-run shows up', () => {
    const named: { game?: string } = {}
    setAgentRunIdentity(() => ({ preset: 'Game Agent', game: named.game }))
    const first = rootSpan()
    stampSpanStart(first)
    named.game = 'Asteroid Rush'
    const second = rootSpan()
    stampSpanStart(second)
    expect(first.name).toBe('Game Agent')
    expect(second.name).toBe('Game Agent · Asteroid Rush')
  })

  it('prefers updateName on a live span', () => {
    setAgentRunIdentity(() => ({ preset: 'Game Agent' }))
    const names: string[] = []
    const span = {
      name: 'pi agent run',
      attributes: {} as Record<string, unknown>,
      isRecording: () => true,
      setAttribute: (key: string, value: string | number | boolean) => {
        span.attributes[key] = value
      },
      updateName: (name: string) => names.push(name),
    }
    stampSpanStart(span)
    expect(names).toEqual(['Game Agent'])
    expect(span.attributes[PRESET]).toBe('Game Agent')
  })
})
