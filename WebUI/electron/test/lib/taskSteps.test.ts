import { describe, expect, it } from 'vitest'
import {
  firstStepTurn,
  runInputOf,
  runPrompt,
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

describe('the prompt a run is sent', () => {
  const instruction =
    'Carry out these steps. They are instructions, not a script: follow them in order unless a ' +
    'step says otherwise, and a step may be conditional or repeat. When a step needs the ' +
    "user's input, ask for it in your reply and stop; the answer arrives as the next message."

  it('holds the instruction and every Step, numbered in order', () => {
    expect(runPrompt('', ['search', 'summarise', 'send'])).toBe(
      instruction + '\n\n1. search\n2. summarise\n3. send',
    )
  })

  it('carries the Start Prompt after the Steps, with the follow-the-user clause', () => {
    expect(runPrompt(' only news from Germany ', ['search', 'summarise'])).toBe(
      instruction +
        '\n\n1. search\n2. summarise\n\n' +
        'For this run the user added: "only news from Germany"\n' +
        'Apply it to every step it is relevant to. Where it conflicts with a step, follow the user.',
    )
  })

  it('leaves out the Start Prompt clause when there is none', () => {
    expect(runPrompt(' \n\t ', ['search'])).not.toContain('For this run')
  })

  it('gives one Step the same shape', () => {
    expect(runPrompt('', ['search'])).toBe(instruction + '\n\n1. search')
  })

  it('recovers the Start Prompt from a run prompt and from an old first-Step prompt', () => {
    expect(runInputOf(runPrompt('only news', ['search', 'summarise']))).toBe('only news')
    expect(runInputOf(firstStepTurn('only news', ['search', 'summarise']))).toBe('only news')
    expect(runInputOf(runPrompt('', ['search']))).toBeUndefined()
  })
})
