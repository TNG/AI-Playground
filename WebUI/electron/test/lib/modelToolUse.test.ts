import { describe, expect, it } from 'vitest'
import { catalogModelToolUse, gateCapabilityCatalog } from '@/lib/modelToolUse'

const catalog = ['files', 'media', 'rag', 'web', 'memory'].map((id) => ({
  id,
  label: id,
  summary: '',
  requires: [],
  commands: [],
}))

const reasons = (entries: { id: string; unavailableReason?: string }[]) =>
  Object.fromEntries(entries.map((entry) => [entry.id, entry.unavailableReason]))

describe('gateCapabilityCatalog', () => {
  it('disables file and shell editing, with a reason, for a model not suited to agent work', () => {
    const use = catalogModelToolUse('llamaCPP', { supportsToolCalling: true })
    expect(reasons(gateCapabilityCatalog(catalog, use))).toEqual({
      files: 'Needs a model suited to agent work.',
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
    expect(Object.values(reasons(gateCapabilityCatalog(catalog, agentic)))).toEqual(
      catalog.map(() => undefined),
    )
    const cloud = catalogModelToolUse('cloud', undefined)
    expect(Object.values(reasons(gateCapabilityCatalog(catalog, cloud)))).toEqual(
      catalog.map(() => undefined),
    )
  })

  it('disables every capability for an untagged user-added model, which gets no tools', () => {
    const use = catalogModelToolUse('llamaCPP', {})
    for (const reason of Object.values(reasons(gateCapabilityCatalog(catalog, use)))) {
      expect(reason).toBe('This model cannot call tools.')
    }
  })

  it("keeps main's own reason when it has one", () => {
    const withReason = [{ ...catalog[0], unavailableReason: 'Not here.' }]
    const use = catalogModelToolUse('llamaCPP', { supportsToolCalling: true })
    expect(gateCapabilityCatalog(withReason, use)[0].unavailableReason).toBe('Not here.')
  })
})
