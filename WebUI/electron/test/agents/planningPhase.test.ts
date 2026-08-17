import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  endThinking,
  planExists,
  PLAN_FILE,
  thinkingIsOn,
  writesPlan,
} from '../../agentMode/planningPhase.ts'

// Thinking is switched off for the rest of a Game Maker run once the agent has
// written its plan to `design.md`. These cover the two halves of that: reading
// and mutating the live sampling bag, and recognising the call that writes the
// plan.

const withThinking = (enabled: boolean) => ({
  temperature: 0.7,
  chat_template_kwargs: { enable_thinking: enabled, reasoning_effort: 'low' },
})

describe('the thinking switch', () => {
  it('turns thinking off in place, leaving the rest of the sampling alone', () => {
    const params = withThinking(true)
    expect(thinkingIsOn(params)).toBe(true)
    expect(endThinking(params)).toBe(true)
    expect(params.chat_template_kwargs.enable_thinking).toBe(false)
    expect(params.chat_template_kwargs.reasoning_effort).toBe('low')
    expect(params.temperature).toBe(0.7)
  })

  it('reports nothing to do when thinking is already off', () => {
    const params = withThinking(false)
    expect(thinkingIsOn(params)).toBe(false)
    expect(endThinking(params)).toBe(false)
  })

  // The switch belongs to the user; a run may end their thinking phase early but
  // never start one, and a model whose template ignores the kwarg gets no key.
  it('never invents the switch for a model that has none', () => {
    const params: Record<string, unknown> = { temperature: 0.7 }
    expect(thinkingIsOn(params)).toBe(false)
    expect(endThinking(params)).toBe(false)
    expect(params.chat_template_kwargs).toBeUndefined()
    expect(endThinking(undefined)).toBe(false)
    expect(thinkingIsOn(undefined)).toBe(false)
  })
})

describe('spotting the plan being written', () => {
  it('matches the plan file whatever tool writes it and however it is spelled', () => {
    expect(writesPlan('write', { path: PLAN_FILE })).toBe(true)
    expect(writesPlan('edit', { path: 'design.md' })).toBe(true)
    expect(writesPlan('write', { path: 'games/neon/design.md' })).toBe(true)
    expect(writesPlan('write', { path: 'games\\neon\\DESIGN.md' })).toBe(true)
  })

  it('ignores other files, other tools and malformed arguments', () => {
    expect(writesPlan('write', { path: 'game.js' })).toBe(false)
    expect(writesPlan('write', { path: 'notes/design.md.bak' })).toBe(false)
    expect(writesPlan('read', { path: 'design.md' })).toBe(false)
    expect(writesPlan('browser', { action: 'probe' })).toBe(false)
    expect(writesPlan('write', {})).toBe(false)
    expect(writesPlan('write', null)).toBe(false)
  })
})

describe('finding a plan already on disk', () => {
  it('sees the plan only once the file is there', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-plan-'))
    try {
      expect(planExists(workspace)).toBe(false)
      fs.writeFileSync(path.join(workspace, PLAN_FILE), '# Pitch\nDodge rocks.\n')
      expect(planExists(workspace)).toBe(true)
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true })
    }
  })
})
