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

const CATALOG = [{ id: 'files' }, { id: 'media' }, { id: 'web' }, { id: 'memory' }]

describe('agent settings sections', () => {
  it('give Assistant sampling, its own prompt, speak-replies and the files switch', () => {
    const sections = agentSettingsSections(shipped('assistant.json'))

    expect(sections).toEqual({
      sampling: true,
      systemPrompt: true,
      speakReplies: true,
      filesCapability: true,
    })
    expect(checklistCapabilities(CATALOG, sections).map(({ id }) => id)).toContain('files')
  })

  it.each(['game-agent.json', 'quick-coder.json'])(
    'leave %s as it was, without a files switch that would change nothing',
    (file) => {
      const sections = agentSettingsSections(shipped(file))

      expect(sections).toEqual({
        sampling: false,
        systemPrompt: false,
        speakReplies: false,
        filesCapability: false,
      })
      expect(checklistCapabilities(CATALOG, sections).map(({ id }) => id)).toEqual([
        'media',
        'web',
        'memory',
      ])
    },
  )
})
