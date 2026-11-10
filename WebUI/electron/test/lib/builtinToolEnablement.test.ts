import { describe, expect, it } from 'vitest'
import { isToolEnabled } from '@/lib/builtinToolEnablement'

describe('isToolEnabled', () => {
  it('turns speech on by default, but leaves it opt-in on NPU', () => {
    expect(isToolEnabled({}, 'synthesizeTextToSpeech')).toBe(true)
    expect(isToolEnabled({}, 'synthesizeTextToSpeech', { onNpu: true })).toBe(false)
    expect(isToolEnabled({}, 'transcribeAudio', { onNpu: true })).toBe(false)
    expect(isToolEnabled({ transcribeAudio: true }, 'transcribeAudio', { onNpu: true })).toBe(true)
  })

  it('keeps media on by default on NPU, and the screenshot tool opt-in everywhere', () => {
    expect(isToolEnabled({}, 'comfyUI', { onNpu: true })).toBe(true)
    expect(isToolEnabled({}, 'captureScreenshot')).toBe(false)
  })
})
