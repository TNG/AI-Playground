import { describe, expect, it } from 'vitest'
import { AgentModeTurnConfigSchema } from '@/types/agentIpc'
import { OVERVIEW_CHROME_KEYS } from '@/types/overviewChrome'

const localConfig = {
  sessionId: 's1',
  workspaceDir: '/tmp/ws',
  modelConfig: {
    source: 'local' as const,
    model: 'qwen',
    baseUrl: 'http://127.0.0.1:39000/v1',
  },
}

const chrome = {
  locale: 'en-US',
  strings: Object.fromEntries(OVERVIEW_CHROME_KEYS.map((key) => [key, key])),
}

describe('AgentModeTurnConfigSchema', () => {
  it('accepts a local turn config', () => {
    const parsed = AgentModeTurnConfigSchema.safeParse(localConfig)
    expect(parsed.success).toBe(true)
  })

  it('accepts a cloud turn config', () => {
    const parsed = AgentModeTurnConfigSchema.safeParse({
      sessionId: 's1',
      workspaceDir: '/tmp/ws',
      modelConfig: {
        source: 'cloud',
        model: 'gpt-4o',
        upstreamBaseUrl: 'https://api.example',
        providerId: 'openai',
        authStyle: 'bearer',
      },
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects a missing session id or workspace', () => {
    expect(AgentModeTurnConfigSchema.safeParse({ ...localConfig, sessionId: '' }).success).toBe(
      false,
    )
    const { workspaceDir: _workspaceDir, ...rest } = localConfig
    expect(AgentModeTurnConfigSchema.safeParse(rest).success).toBe(false)
  })

  it('accepts a complete Overview chrome', () => {
    const parsed = AgentModeTurnConfigSchema.safeParse({
      ...localConfig,
      overviewChrome: chrome,
    })
    expect(parsed.success).toBe(true)
  })

  it('rejects an Overview chrome missing a string or its locale', () => {
    const { OVERVIEW_RANGE: _range, ...strings } = chrome.strings
    expect(
      AgentModeTurnConfigSchema.safeParse({
        ...localConfig,
        overviewChrome: { ...chrome, strings },
      }).success,
    ).toBe(false)
    expect(
      AgentModeTurnConfigSchema.safeParse({
        ...localConfig,
        overviewChrome: { ...chrome, locale: '' },
      }).success,
    ).toBe(false)
  })
})
