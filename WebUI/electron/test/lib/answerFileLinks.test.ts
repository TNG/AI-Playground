import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { createdFilesOf, createdFilesOfMessages } from '@/lib/answerFileLinks'

function messageOf(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as unknown as UIMessage
}

function writeOf(id: string, path: string): unknown {
  return {
    type: 'dynamic-tool',
    toolCallId: id,
    toolName: 'write',
    state: 'output-available',
    input: { path },
  }
}

describe('createdFilesOf', () => {
  it('collects the paths of the writing tools that finished', () => {
    const message = messageOf([
      {
        type: 'dynamic-tool',
        toolCallId: 't1',
        toolName: 'write',
        state: 'output-available',
        input: { path: 'game.js' },
      },
      {
        type: 'dynamic-tool',
        toolCallId: 't2',
        toolName: 'multi_edit',
        state: 'output-available',
        input: { path: 'game.js', edits: [] },
      },
      {
        type: 'dynamic-tool',
        toolCallId: 't3',
        toolName: 'edit',
        state: 'input-available',
        input: { path: 'running.js' },
      },
      {
        type: 'dynamic-tool',
        toolCallId: 't4',
        toolName: 'write',
        state: 'output-error',
        input: { path: 'failed.js' },
      },
      {
        type: 'dynamic-tool',
        toolCallId: 't5',
        toolName: 'bash',
        state: 'output-available',
        input: { command: 'ls' },
      },
      {
        type: 'dynamic-tool',
        toolCallId: 't6',
        toolName: 'write',
        state: 'output-available',
        input: { content: 'no path' },
      },
      { type: 'text', text: 'Done' },
    ])
    expect(createdFilesOf(message)).toEqual(['game.js'])
  })
})

describe('createdFilesOfMessages', () => {
  it('collects across a turn’s answers, deduped, in first-seen order', () => {
    const first = messageOf([writeOf('t1', 'design.md')])
    const second = messageOf([writeOf('t2', 'game.js'), writeOf('t3', 'design.md')])
    expect(createdFilesOfMessages([first, second])).toEqual(['design.md', 'game.js'])
  })

  it('keeps distinct raw paths that share a basename', () => {
    const first = messageOf([writeOf('t1', 'a/game.js')])
    const second = messageOf([writeOf('t2', 'b/game.js')])
    expect(createdFilesOfMessages([first, second])).toEqual(['a/game.js', 'b/game.js'])
  })

  it('returns nothing for a turn without writing tools', () => {
    const answer = messageOf([{ type: 'text', text: 'Done' }])
    expect(createdFilesOfMessages([answer])).toEqual([])
    expect(createdFilesOfMessages([])).toEqual([])
  })
})
