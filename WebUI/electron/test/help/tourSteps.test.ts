import { describe, expect, it } from 'vitest'
import { getHelpTopic } from '@/assets/js/help/helpTopics'
import { TOUR_ONLY_ANCHORS, tourSteps } from '@/assets/js/help/tourSteps'

const ids = (style: 'classic' | 'modern') => tourSteps(style).map((step) => step.id)

describe('demo tour steps', () => {
  it('walks Classic through the mode buttons, prompt and send', () => {
    expect(ids('classic')).toEqual([
      '#contextual-help-toggle',
      '#mode-buttons',
      '#prompt-input',
      '#send-button',
    ])
  })

  it('walks Modern through the Mode dropdown, then the preset dropdown', () => {
    expect(ids('modern')).toEqual([
      '#contextual-help-toggle',
      '#mode-dropdown',
      '#preset-dropdown',
      '#prompt-input',
      '#send-button',
    ])
  })

  it('gives every Modern anchor a click-to-learn topic', () => {
    const tourOnly = new Set<string>(TOUR_ONLY_ANCHORS)
    for (const id of ids('modern').filter((id) => !tourOnly.has(id))) {
      expect(getHelpTopic(id.slice(1)), `missing help topic for ${id}`).toBeDefined()
    }
  })
})
