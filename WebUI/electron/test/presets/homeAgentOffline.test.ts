import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

describe('home agent offline model', () => {
  it('prefers the Gemma OpenVINO snapshot the offline payload ships', () => {
    const file = path.resolve(__dirname, '../../../../modes/base/presets/home-agent-chat.json')
    const preset = JSON.parse(readFileSync(file, 'utf8')) as {
      preferredModels: { openVINO: string; llamaCPP: string }
    }
    expect(preset.preferredModels.openVINO).toBe('OpenVINO/gemma-4-E4B-it-int4-ov')
    expect(preset.preferredModels.llamaCPP).toContain('Qwen3.5-9B')
  })
})
