import { describe, expect, it } from 'vitest'
import {
  firstStepTurn,
  stepPrompts,
  stepTurn,
  withStepInserted,
  withStepMoved,
} from '@/lib/taskSteps'

const steps = (...prompts: string[]) =>
  prompts.map((prompt, index) => ({ id: `s${index}`, prompt }))

describe('inserting a Step', () => {
  it('puts an empty Step right after the chosen one', () => {
    const inserted = withStepInserted(steps('search', 'summarise'), 's0')

    expect(inserted.map((step) => step.prompt)).toEqual(['search', '', 'summarise'])
    expect(new Set(inserted.map((step) => step.id)).size).toBe(3)
  })

  it('appends when the chosen Step is gone', () => {
    expect(withStepInserted(steps('search'), 'missing').map((step) => step.prompt)).toEqual([
      'search',
      '',
    ])
  })
})

describe('moving a Step', () => {
  it('leaves the order alone at either end', () => {
    const list = steps('one', 'two')
    expect(withStepMoved(list, 's0', 'up')).toBe(list)
    expect(withStepMoved(list, 's1', 'down')).toBe(list)
  })
})

describe('the turns a prompt is carried out in', () => {
  it('drops empty Steps and trims the rest', () => {
    expect(stepPrompts(steps(' search ', '  ', 'summarise'))).toEqual(['search', 'summarise'])
  })

  const adjustment = (request: string) =>
    `For this run the user added: "${request}"\n` +
    'Apply it to every step it is relevant to. Where it conflicts with a step, follow the user.\n\n'

  it('opens with the plan, then the prompt as a run adjustment, then Step 1', () => {
    expect(firstStepTurn(' only news from Germany ', ['search', 'summarise'])).toBe(
      'Carry this out in 2 steps. I will send them one at a time; do only the ' +
        'current one, then stop.\n\n' +
        adjustment('only news from Germany') +
        'Step 1 of 2: search',
    )
  })

  it('leaves out the prompt block when the prompt is empty', () => {
    const plain =
      'Carry this out in 2 steps. I will send them one at a time; do only the ' +
      'current one, then stop.\n\nStep 1 of 2: search'
    expect(firstStepTurn('', ['search', 'summarise'])).toBe(plain)
    expect(firstStepTurn(' \n\t ', ['search', 'summarise'])).toBe(plain)
  })

  it('numbers each later Step', () => {
    expect(stepTurn(2, ['search', 'summarise'])).toBe('Step 2 of 2: summarise')
  })

  it('does not number a single Step', () => {
    expect(firstStepTurn('only news from Germany', ['search'])).toBe(
      'Carry this out in one step:\n\n' + adjustment('only news from Germany') + 'search',
    )
    expect(firstStepTurn(' ', ['search'])).toBe('Carry this out in one step:\n\nsearch')
    expect(stepTurn(1, ['search'])).toBe('search')
  })
})
