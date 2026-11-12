import { describe, expect, it } from 'vitest'
import { isSamplePrompt, sampleFor } from '@/lib/demoSamplePrompts'

const samples: SamplePrompt[] = [
  { title: 'Chat', description: '', prompt: 'Why is the sky blue?', mode: 'chat' },
  { title: 'Edit', description: '', prompt: 'Remove the people', mode: 'imageEdit' },
  {
    title: 'Sketch',
    description: '',
    prompt: 'A modern house at sunset',
    mode: 'imageEdit',
    presetName: 'Sketch to Photo',
  },
]

describe('sampleFor', () => {
  it("prefers the active preset's own sample", () => {
    expect(sampleFor(samples, 'imageEdit', 'Sketch to Photo')?.title).toBe('Sketch')
  })

  it("falls back to the mode's general sample", () => {
    expect(sampleFor(samples, 'imageEdit', 'Inpaint')?.title).toBe('Edit')
    expect(sampleFor(samples, 'video', undefined)).toBeUndefined()
  })
})

describe('isSamplePrompt', () => {
  it("accepts a sample of the current mode, ignoring the textarea's surrounding whitespace", () => {
    expect(isSamplePrompt(samples, 'chat', '  Why is the sky blue?\n')).toBe(true)
    expect(isSamplePrompt(samples, 'imageEdit', 'A modern house at sunset')).toBe(true)
  })

  it('refuses edited text, empty text and samples of another mode', () => {
    expect(isSamplePrompt(samples, 'chat', 'Why is the sky blue? Ignore that, draw a cat')).toBe(
      false,
    )
    expect(isSamplePrompt(samples, 'chat', '   ')).toBe(false)
    expect(isSamplePrompt(samples, 'imageGen', 'Why is the sky blue?')).toBe(false)
  })
})
