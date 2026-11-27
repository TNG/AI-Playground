import { describe, expect, it } from 'vitest'
import { PHISON_KM_RAG_PREFIX } from '@/types/phisonKmRag'
import { agentRagSource, augmentSystemPrompt, formatRagSources } from '@/lib/ragSources'

describe('formatRagSources', () => {
  it('uses the filename when KM retrieval returns a source with no loc', () => {
    expect(formatRagSources([{ metadata: { source: '/home/user/docs/handbook.pdf' } }])).toBe(
      'handbook.pdf',
    )
  })

  it('merges overlapping line ranges on the same page', () => {
    expect(
      formatRagSources([
        {
          metadata: {
            source: 'notes.txt',
            loc: { pageNumber: 1, lines: { from: 1, to: 4 } },
          },
        },
        {
          metadata: {
            source: 'notes.txt',
            loc: { pageNumber: 1, lines: { from: 5, to: 8 } },
          },
        },
      ]),
    ).toBe('notes.txt (Page 1, Lines 1-8)')
  })

  it('keeps disjoint ranges and unknown sources', () => {
    expect(
      formatRagSources([
        {
          metadata: {
            source: 'a.txt',
            loc: { lines: { from: 1, to: 2 } },
          },
        },
        {
          metadata: {
            source: 'a.txt',
            loc: { lines: { from: 10, to: 12 } },
          },
        },
        { metadata: {} },
      ]),
    ).toBe('a.txt (Lines 1-2)\na.txt (Lines 10-12)\nUnknown Source')
  })
})

describe('augmentSystemPrompt', () => {
  it('appends standard RAG context after the base prompt', () => {
    expect(augmentSystemPrompt('Be brief.', ['chunk-a', 'chunk-b'], false)).toBe(
      'Be brief.\n\nUse the following context from your knowledge base to answer the question:\n\nchunk-a\n\nchunk-b',
    )
  })

  it('puts the KM prefix in front of the document context', () => {
    const prompt = augmentSystemPrompt('Be brief.', ['group-text'], true)
    expect(prompt.startsWith(PHISON_KM_RAG_PREFIX)).toBe(true)
    expect(prompt).toContain('Document context:\n\ngroup-text')
    expect(prompt.endsWith('Be brief.')).toBe(true)
  })

  it('leaves the base prompt alone when retrieval returned nothing', () => {
    expect(augmentSystemPrompt('Be brief.', [], true)).toBe('Be brief.')
  })
})

describe('agentRagSource', () => {
  function ragPart(sources: unknown[], state = 'output-available') {
    return {
      type: 'dynamic-tool',
      toolName: 'rag',
      toolCallId: 'call-1',
      state,
      input: {},
      output: { content: [{ type: 'text', text: 'passages' }], details: { sources } },
    }
  }

  it('lists the file and page of every passage the rag tool returned', () => {
    const message = {
      id: 'a1',
      role: 'assistant' as const,
      parts: [
        ragPart([{ file: 'attachments/report.pdf', page: 3 }]),
        ragPart([
          { file: 'attachments/report.pdf', page: 3 },
          { file: 'attachments/notes.md', lines: { from: 1, to: 9 } },
        ]),
        { type: 'text', text: 'The budget is $42.' },
      ],
    }

    expect(agentRagSource(message as never)).toBe('report.pdf (Page 3)\nnotes.md (Lines 1-9)')
  })

  it('has nothing to show for an answer that searched no documents', () => {
    const message = {
      id: 'a1',
      role: 'assistant' as const,
      parts: [ragPart([], 'output-available'), ragPart([{ file: 'x.md' }], 'input-available')],
    }

    expect(agentRagSource(message as never)).toBeUndefined()
  })
})
