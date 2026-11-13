import { describe, expect, it } from 'vitest'
import { mediaModeFallbackPreset } from '@/lib/mediaModeFallbackPreset'
import type { Preset } from '@/lib/presetSchemas'

const preset = (fields: Record<string, unknown>) => fields as unknown as Preset

const flux = preset({ name: 'Flux', type: 'comfy', category: 'create-images' })
const edit = preset({ name: 'Edit', type: 'comfy', category: 'edit-images' })
const video = preset({ name: 'Wan', type: 'comfy', category: 'create-videos' })
const tts = preset({ name: 'Text to Speech', type: 'chat', category: 'audio' })
const assistant = preset({ name: 'Assistant', type: 'chat', category: 'chat', agentPreset: true })
const aidaptiv = preset({ name: 'aiDAPTIV', type: 'chat', category: 'chat' })
const gameAgent = preset({ name: 'Game Agent', type: 'chat', category: 'chat', agentPreset: true })

describe('the preset to leave a Media Mode for', () => {
  it.each([flux, edit, video, tts])('is Assistant for $name with Media Modes off', (active) => {
    expect(mediaModeFallbackPreset(active, false)).toBe('Assistant')
  })

  it.each([assistant, aidaptiv, gameAgent])('is nothing for $name with Media Modes off', (p) => {
    expect(mediaModeFallbackPreset(p, false)).toBeNull()
  })

  it.each([flux, tts, assistant])('is nothing for $name with Media Modes on', (active) => {
    expect(mediaModeFallbackPreset(active, true)).toBeNull()
  })

  it('is nothing while no preset is active', () => {
    expect(mediaModeFallbackPreset(undefined, false)).toBeNull()
  })
})
