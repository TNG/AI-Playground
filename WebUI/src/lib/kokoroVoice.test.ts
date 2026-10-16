import { describe, expect, it } from 'vitest'
import { describeKokoroVoice, externalTtsEngineNote, kokoroEngineNote } from './kokoroVoice'

describe('describeKokoroVoice', () => {
  it('names the American and British voices instead of leaving the prefix', () => {
    expect(describeKokoroVoice('af_heart')).toBe('American English female voice Heart (af_heart)')
    expect(describeKokoroVoice('am_adam')).toBe('American English male voice Adam (am_adam)')
    expect(describeKokoroVoice('bf_emma')).toBe('British English female voice Emma (bf_emma)')
    expect(describeKokoroVoice('bm_george')).toBe('British English male voice George (bm_george)')
  })

  it('leaves an id it does not recognize unchanged', () => {
    expect(describeKokoroVoice('Vivian')).toBe('Vivian')
    expect(describeKokoroVoice('')).toBe('')
  })
})

describe('engine notes', () => {
  it('tells the model Kokoro will not switch language', () => {
    const note = kokoroEngineNote('af_heart')

    expect(note).toContain('American English female voice Heart (af_heart)')
    expect(note).toContain('do not change this voice')
    expect(note).not.toContain('Afrikaans')
  })

  it('does not invent a language for an external voice id', () => {
    expect(externalTtsEngineNote('nova')).toContain('the configured voice (nova)')
    expect(externalTtsEngineNote('')).toContain('its configured voice')
    expect(externalTtsEngineNote('nova')).toContain('Do not infer a language')
  })
})
