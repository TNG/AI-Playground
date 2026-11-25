import { describe, expect, it } from 'vitest'
import { createdFileEntriesOf } from '@/lib/sessionCreatedFiles'

function answerOf(
  id: string,
  harnessSessionId: string,
  files: string[],
  createdAt?: number,
): unknown {
  return {
    id,
    role: 'assistant',
    createdAt,
    parts: files.map((path, index) => ({
      type: 'dynamic-tool',
      toolCallId: `${id}-t${index}`,
      toolName: 'write',
      state: 'output-available',
      input: { path },
    })),
    metadata: { agentTurn: { presetName: 'Game Agent', harnessSessionId } },
  }
}

function chatAnswerOf(id: string, files: string[]): unknown {
  return {
    id,
    role: 'assistant',
    parts: files.map((path, index) => ({
      type: 'dynamic-tool',
      toolCallId: `${id}-t${index}`,
      toolName: 'write',
      state: 'output-available',
      input: { path },
    })),
    metadata: { chatTurn: true },
  }
}

describe('createdFileEntriesOf', () => {
  it('collects the files of the timeline agent turns with their message timestamps', () => {
    const entries = createdFileEntriesOf(
      [answerOf('m1', 'h1', ['game.js', 'design.md'], 1_000)],
      () => 9_999,
    )
    expect(entries).toEqual([
      { file: 'game.js', sessionId: 'h1', createdAt: 1_000 },
      { file: 'design.md', sessionId: 'h1', createdAt: 1_000 },
    ])
  })

  it('keeps one entry per file, the latest write winning', () => {
    const entries = createdFileEntriesOf(
      [answerOf('m1', 'h1', ['game.js'], 1_000), answerOf('m2', 'h1', ['game.js'], 2_000)],
      () => 9_999,
    )
    expect(entries).toEqual([{ file: 'game.js', sessionId: 'h1', createdAt: 2_000 }])
  })

  it('keys files by harness session, so two sessions may share a name', () => {
    const entries = createdFileEntriesOf(
      [answerOf('m1', 'h1', ['game.js'], 1_000), answerOf('m2', 'h2', ['game.js'], 2_000)],
      () => 9_999,
    )
    expect(entries).toEqual([
      { file: 'game.js', sessionId: 'h1', createdAt: 1_000 },
      { file: 'game.js', sessionId: 'h2', createdAt: 2_000 },
    ])
  })

  it('falls back per harness session, so a stale fallback cannot re-float another game file', () => {
    const entries = createdFileEntriesOf(
      [answerOf('m1', 'h1', ['old.js']), answerOf('m2', 'h2', ['new.js'], 8_000)],
      (harnessId) => (harnessId === 'h1' ? 500 : 9_999),
    )
    expect(entries).toEqual([
      { file: 'old.js', sessionId: 'h1', createdAt: 500 },
      { file: 'new.js', sessionId: 'h2', createdAt: 8_000 },
    ])
  })

  it('a re-write with a real stamp beats the fallback of an older unstamped write', () => {
    const entries = createdFileEntriesOf(
      [answerOf('m1', 'h1', ['game.js']), answerOf('m2', 'h1', ['game.js'], 8_000)],
      () => 500,
    )
    expect(entries).toEqual([{ file: 'game.js', sessionId: 'h1', createdAt: 8_000 }])
  })

  it('ignores non-agent turns', () => {
    expect(createdFileEntriesOf([chatAnswerOf('m1', ['chat.txt'])], () => 9_999)).toEqual([])
  })
})
