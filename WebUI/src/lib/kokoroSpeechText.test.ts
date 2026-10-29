import { describe, expect, it } from 'vitest'
import { prepareKokoroText } from './kokoroSpeechText'

describe('prepareKokoroText', () => {
  it.each([
    ['$2.3 Billion', '2.3 Billion dollars'],
    ['$2.3 billion', '2.3 billion dollars'],
    ['It cost $5 million.', 'It cost 5 million dollars.'],
    ['£1,200 thousand', '1,200 thousand pounds'],
    ['€ 4 trillion', '4 trillion euros'],
    ['$1 and $2.3 billion', '$1 and 2.3 billion dollars'],
  ])('rewrites %j', (input, expected) => {
    expect(prepareKokoroText(input)).toBe(expected)
  })

  it.each(['$2.30', 'It costs $5.', '2.3 billion people', '$2 billionaires'])(
    'leaves %j unchanged',
    (input) => {
      expect(prepareKokoroText(input)).toBe(input)
    },
  )
})
