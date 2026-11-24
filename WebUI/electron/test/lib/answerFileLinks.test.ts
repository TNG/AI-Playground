import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { createdFilesOf, linkifyAnswerFiles } from '@/lib/answerFileLinks'

function messageOf(parts: unknown[]): UIMessage {
  return { id: 'm1', role: 'assistant', parts } as unknown as UIMessage
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

describe('linkifyAnswerFiles', () => {
  it('links a bare mention of the created file', () => {
    const text = 'I created game.js in the workspace.'
    expect(linkifyAnswerFiles(text, ['game.js'])).toBe(
      'I created [game.js](aipg-file:game.js) in the workspace.',
    )
  })

  it('keeps every mention clickable, with the tooltip on each', () => {
    const text = 'game.js is done — open game.js to see it.'
    expect(linkifyAnswerFiles(text, ['game.js'], 'Open it')).toBe(
      '[game.js](aipg-file:game.js "Open it") is done — open [game.js](aipg-file:game.js "Open it") to see it.',
    )
  })

  it('links a mounted-folder reference as written', () => {
    const text = 'Check /mnt/data/todo.txt when you have time.'
    expect(linkifyAnswerFiles(text, ['/mnt/data/todo.txt'])).toBe(
      'Check [/mnt/data/todo.txt](aipg-file:%2Fmnt%2Fdata%2Ftodo.txt) when you have time.',
    )
  })

  it('prefers the longer form where both it and the basename appear', () => {
    const text = 'The plan is design.md, the game is game.js, both under /workspace.'
    expect(linkifyAnswerFiles(text, ['/workspace/design.md', '/workspace/game.js'])).toBe(
      'The plan is [design.md](aipg-file:%2Fworkspace%2Fdesign.md), the game is [game.js](aipg-file:%2Fworkspace%2Fgame.js), both under /workspace.',
    )
  })

  it('leaves an ambiguous basename plain', () => {
    const text = 'Both folders have their own game.js in them.'
    expect(linkifyAnswerFiles(text, ['a/game.js', 'b/game.js'])).toBe(text)
  })

  it('does not link a partial extension match', () => {
    const text = 'The file game.jsx is different.'
    expect(linkifyAnswerFiles(text, ['game.js'])).toBe(text)
  })

  it('leaves mentions inside code untouched', () => {
    const text = 'Run `node game.js` next:\n\n```js\n// game.js lives here\n```\nSee game.js there.'
    const result = linkifyAnswerFiles(text, ['game.js'])
    expect(result).toContain('`node game.js`')
    expect(result).toContain('// game.js lives here')
    expect(result.endsWith('See [game.js](aipg-file:game.js) there.')).toBe(true)
  })

  it('links a mention behind an @ reference', () => {
    const text = 'All details are in @design.md.'
    expect(linkifyAnswerFiles(text, ['design.md'])).toBe(
      'All details are in @[design.md](aipg-file:design.md).',
    )
  })

  it('returns the text unchanged when nothing can link', () => {
    expect(linkifyAnswerFiles('No tools ran here.', [])).toBe('No tools ran here.')
    expect(linkifyAnswerFiles('', ['game.js'])).toBe('')
  })
})
