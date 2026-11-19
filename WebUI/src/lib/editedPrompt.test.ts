import { describe, expect, it } from 'vitest'
import { applyEditedPrompt, editedPromptParts } from './editedPrompt'

const message = (parts: unknown[]) => ({ parts: parts as { type: string; text?: string }[] })

describe('editedPromptParts', () => {
  it('replaces the text with a single edited part', () => {
    const parts = editedPromptParts(message([{ type: 'text', text: 'old' }]), 'new')
    expect(parts).toEqual([{ type: 'text', text: 'new' }])
  })

  it('keeps attached files around the edited text', () => {
    const parts = editedPromptParts(
      message([
        { type: 'file', mediaType: 'image/png', url: 'file://a.png' },
        { type: 'text', text: 'old' },
        { type: 'text', text: 'more' },
      ]),
      'new',
    )
    expect(parts).toEqual([
      { type: 'file', mediaType: 'image/png', url: 'file://a.png' },
      { type: 'text', text: 'new' },
    ])
  })

  it('drops the extra text parts and keeps files after them', () => {
    const parts = editedPromptParts(
      message([
        { type: 'text', text: 'old' },
        { type: 'file', mediaType: 'audio/wav', url: 'file://a.wav' },
        { type: 'text', text: 'trailing' },
      ]),
      'new',
    )
    expect(parts).toEqual([
      { type: 'text', text: 'new' },
      { type: 'file', mediaType: 'audio/wav', url: 'file://a.wav' },
    ])
  })

  it('reports a no-op edit with null', () => {
    expect(editedPromptParts(message([{ type: 'text', text: 'same' }]), 'same')).toBeNull()
  })

  it('refuses a message without text parts', () => {
    expect(editedPromptParts(message([{ type: 'file', url: 'file://a.png' }]), 'new')).toBeNull()
    expect(editedPromptParts(undefined, 'new')).toBeNull()
  })
})

describe('applyEditedPrompt', () => {
  it('splices the parts into the message itself', () => {
    const target = message([
      { type: 'text', text: 'old' },
      { type: 'file', url: 'file://a.png' },
    ])
    expect(applyEditedPrompt(target, 'new')).toBe(true)
    expect(target.parts).toEqual([
      { type: 'text', text: 'new' },
      { type: 'file', url: 'file://a.png' },
    ])
  })

  it('leaves the message alone when nothing changes', () => {
    const target = message([{ type: 'text', text: 'same' }])
    expect(applyEditedPrompt(target, 'same')).toBe(false)
    expect(target.parts).toEqual([{ type: 'text', text: 'same' }])
  })
})
