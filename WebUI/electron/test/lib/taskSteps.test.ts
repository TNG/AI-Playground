import { describe, expect, it } from 'vitest'
import {
  runInputOf,
  runPrompt,
  stepPrompts,
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

describe('the prompt a run is sent', () => {
  it('drops empty Steps and trims the rest', () => {
    expect(stepPrompts(steps(' search ', '  ', 'summarise'))).toEqual(['search', 'summarise'])
  })

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
    const oldFirstStep =
      'Carry this out in 2 steps. I will send them one at a time; do only the current one, then ' +
      'stop.\n\nFor this run the user added: "only news"\nApply it to every step it is relevant ' +
      'to. Where it conflicts with a step, follow the user.\n\nStep 1 of 2: search'
    expect(runInputOf(oldFirstStep)).toBe('only news')
    expect(runInputOf(runPrompt('', ['search']))).toBeUndefined()
  })
})
