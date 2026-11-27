import { describe, expect, it } from 'vitest'
import { buildEntries } from '@/assets/js/models/library'
import type { CloudModelInput } from '@/assets/js/models/library'

const base = {
  catalogModels: [],
  scanned: [],
  requiredModels: [],
  speechModels: [],
  preferences: {},
}

const cloudModels: CloudModelInput[] = [
  {
    name: 'provider/model-id',
    capabilities: { supportsVision: true, supportsToolCalling: true },
  },
]

describe('buildEntries cloud models', () => {
  it('lists the provider models as remote llm rows when Cloud Mode has a provider', () => {
    const entries = buildEntries({ ...base, cloudModels })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      name: 'provider/model-id',
      useCase: 'llm',
      pathKey: 'cloud',
      serviceBackend: 'cloud',
      source: 'cloud',
      downloaded: true,
    })
  })

  it('omits the cloud rows when no provider is selected', () => {
    expect(buildEntries({ ...base, cloudModels: [] })).toEqual([])
    expect(buildEntries(base)).toEqual([])
  })

  it('merges the user capability overrides onto the provider caps', () => {
    const entries = buildEntries({
      ...base,
      cloudModels,
      preferences: {
        'cloud:provider/model-id': { capabilities: { supportsAgentic: true } },
      },
    })
    expect(entries[0].capabilities).toMatchObject({
      supportsVision: true,
      supportsToolCalling: true,
      supportsAgentic: true,
    })
    expect(entries[0].hasCapabilityOverrides).toBe(true)
  })

  it('keeps agentic unknown when neither the provider nor the user said', () => {
    const entries = buildEntries({ ...base, cloudModels })
    expect(entries[0].capabilities.supportsAgentic).toBeUndefined()
    expect(entries[0].hasCapabilityOverrides).toBe(false)
  })
})
