import { describe, expect, it } from 'vitest'
import { repairWorkflowToolInput } from './comfyToolRepair'

describe('repairWorkflowToolInput', () => {
  const data = { names: ['Draft Image', 'Photo Real', 'Animate'], defaultWorkflow: 'Draft Image' }

  it('returns null for an already-valid workflow', () => {
    expect(repairWorkflowToolInput('{"prompt":"a cat","workflow":"Photo Real"}', data)).toBeNull()
  })

  it('returns null for a named workflow that matches nothing — the error must reach the model', () => {
    expect(repairWorkflowToolInput('{"prompt":"a cat","workflow":"nope"}', data)).toBeNull()
  })

  it('repairs a near-miss to the named workflow, never to the default', () => {
    const repaired = repairWorkflowToolInput('{"prompt":"a cat","workflow":" photo real "}', data)
    expect(JSON.parse(repaired!)).toEqual({ prompt: 'a cat', workflow: 'Photo Real' })
  })

  it('is case-insensitive on a near-miss', () => {
    const repaired = repairWorkflowToolInput('{"prompt":"a cat","workflow":"PHOTO REAL"}', data)
    expect(JSON.parse(repaired!)).toEqual({ prompt: 'a cat', workflow: 'Photo Real' })
  })

  it('adds the default when workflow is omitted', () => {
    const repaired = repairWorkflowToolInput('{"prompt":"a cat"}', data)
    expect(JSON.parse(repaired!)).toEqual({ prompt: 'a cat', workflow: 'Draft Image' })
  })

  it('fills the default when workflow is blank or not a string', () => {
    const blank = repairWorkflowToolInput('{"prompt":"a cat","workflow":""}', data)
    expect(JSON.parse(blank!)).toEqual({ prompt: 'a cat', workflow: 'Draft Image' })
    const notAString = repairWorkflowToolInput('{"prompt":"a cat","workflow":7}', data)
    expect(JSON.parse(notAString!)).toEqual({ prompt: 'a cat', workflow: 'Draft Image' })
  })

  it('repairs unparseable input into a bare default call', () => {
    const repaired = repairWorkflowToolInput('not json{', data)
    expect(JSON.parse(repaired!)).toEqual({ workflow: 'Draft Image' })
  })

  it('returns null when no workflows exist', () => {
    expect(repairWorkflowToolInput('{}', { names: [], defaultWorkflow: 'Draft Image' })).toBeNull()
  })
})
