import { describe, expect, it } from 'vitest'
import {
  componentChange,
  createComponentChanges,
  uninstallComponent,
  type ComponentChangeDeps,
} from '../../kernel/componentChanges'
import type { HeldComponent } from '@/types/componentChange'

// The in-use guard's invariant: a Component held by work is refused and named,
// an unrelated Component stays changeable, and the refusal lifts when the work
// ends. The kernel handlers consult exactly this rule.

function deps(overrides: Partial<ComponentChangeDeps> = {}): ComponentChangeDeps {
  return { heldComponents: () => [], hasInFlightWork: () => false, ...overrides }
}

describe('componentChange', () => {
  it('allows a Component nothing holds', () => {
    expect(componentChange('comfyui-backend', [])).toEqual({ allowed: true })
  })

  it('refuses a Component a turn holds, naming the work', () => {
    const held: HeldComponent[] = [{ component: 'llamacpp-backend', work: 'turn' }]

    expect(componentChange('llamacpp-backend', held)).toEqual({
      allowed: false,
      code: 'component-in-use',
      work: 'turn',
    })
  })

  it('names the kind of work that holds it', () => {
    const held: HeldComponent[] = [
      { component: 'openvino-backend', work: 'agent-run' },
      { component: 'comfyui-backend', work: 'media-run' },
      { component: 'whisper-backend', work: 'speech-turn' },
      { component: 'qwen3-tts-backend', work: 'model-download' },
    ]

    expect(componentChange('openvino-backend', held)).toMatchObject({ work: 'agent-run' })
    expect(componentChange('comfyui-backend', held)).toMatchObject({ work: 'media-run' })
    expect(componentChange('whisper-backend', held)).toMatchObject({ work: 'speech-turn' })
    expect(componentChange('qwen3-tts-backend', held)).toMatchObject({ work: 'model-download' })
  })

  it('leaves a Component another piece of work does not hold changeable', () => {
    const held: HeldComponent[] = [{ component: 'llamacpp-backend', work: 'turn' }]

    expect(componentChange('comfyui-backend', held)).toEqual({ allowed: true })
  })
})

describe('uninstallComponent', () => {
  it('allows an optional Component to be uninstalled', () => {
    expect(uninstallComponent('comfyui-backend', false)).toEqual({ allowed: true })
  })

  it('refuses a required Component even when nothing holds it', () => {
    expect(uninstallComponent('ai-backend', true)).toEqual({
      allowed: false,
      code: 'component-required',
      error: expect.stringContaining('required'),
    })
  })
})

describe('createComponentChanges', () => {
  it('allows the change once the work holding it finishes', () => {
    let held: HeldComponent[] = [{ component: 'llamacpp-backend', work: 'turn' }]
    const guard = createComponentChanges(deps({ heldComponents: () => held }))

    expect(guard.change('llamacpp-backend').allowed).toBe(false)
    held = []
    expect(guard.change('llamacpp-backend')).toEqual({ allowed: true })
  })

  it('reports whether any In-flight Work exists, for the Hardware Mode change', () => {
    const busy = createComponentChanges(deps({ hasInFlightWork: () => true }))

    expect(busy.anyInFlightWork()).toBe(true)
    expect(createComponentChanges(deps()).anyInFlightWork()).toBe(false)
  })

  it('carries the uninstall rule the kernel handler consults', () => {
    const guard = createComponentChanges(deps())

    expect(guard.uninstall('comfyui-backend', false)).toEqual({ allowed: true })
    expect(guard.uninstall('ai-backend', true)).toMatchObject({ allowed: false })
  })
})
