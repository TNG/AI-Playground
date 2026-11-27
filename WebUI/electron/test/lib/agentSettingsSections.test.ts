import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PresetSchema, type Preset } from '@/assets/js/store/presets'
import { agentSettingsSections, checklistCapabilities } from '@/lib/agentSettingsSections'

// Which sections the agent settings tabs render, for the presets as they ship.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const presetsDir = path.resolve(__dirname, '../../../../modes/base/presets')

function shipped(file: string): Preset {
  return PresetSchema.parse(JSON.parse(readFileSync(path.join(presetsDir, file), 'utf-8')))
}

const CATALOG = [
  { id: 'files' },
  { id: 'media' },
  { id: 'web' },
  { id: 'memory' },
  { id: 'overview', presetOwned: true },
] as const

describe('agent settings sections', () => {
  it('give Assistant sampling, its own prompt, speak-replies and the files switch', () => {
    const sections = agentSettingsSections(shipped('assistant.json'))

    expect(sections).toEqual({
      sampling: true,
      systemPrompt: true,
      speakReplies: true,
      filesCapability: true,
      presetCapabilities: [],
    })
    expect(checklistCapabilities(CATALOG, sections).map(({ id }) => id)).toContain('files')
  })

  it.each([
    ['game-agent.json', ['media', 'web-debug', 'game-studio']],
    ['quick-coder.json', ['game-studio-quick']],
  ])('leave %s as it was, without a files switch that would change nothing', (file, declared) => {
    const sections = agentSettingsSections(shipped(file))

    expect(sections).toEqual({
      sampling: false,
      systemPrompt: false,
      speakReplies: false,
      filesCapability: false,
      presetCapabilities: declared,
    })
    expect(checklistCapabilities(CATALOG, sections).map(({ id }) => id)).toEqual([
      'media',
      'web',
      'memory',
    ])
  })

  it('offers a preset-owned capability only under a preset that names it', () => {
    const overviewAgent = agentSettingsSections(shipped('overview-agent.json'))
    expect(overviewAgent.presetCapabilities).toEqual(['overview'])
    expect(checklistCapabilities(CATALOG, overviewAgent).map(({ id }) => id)).toContain('overview')

    const assistant = agentSettingsSections(shipped('assistant.json'))
    expect(checklistCapabilities(CATALOG, assistant).map(({ id }) => id)).not.toContain('overview')
  })
})
