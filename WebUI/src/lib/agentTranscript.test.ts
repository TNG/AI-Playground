import { describe, expect, it } from 'vitest'
import {
  compactionOutputOf,
  generatedMediaOf,
  isGeneratedMediaTool,
  groupTranscriptParts,
  mediaToolNameOf,
  toolPartNameOf,
  busyLabelOf,
  type TranscriptSegment,
} from './agentTranscript'

function reasoning(ms: number, state: 'streaming' | 'done' = 'done') {
  return {
    type: 'reasoning',
    state,
    providerMetadata: { aipg: { reasoningStarted: 1_000, reasoningFinished: 1_000 + ms } },
  }
}

function tool(name: string, state = 'output-available') {
  return { type: 'dynamic-tool', toolName: name, state, toolCallId: `${name}-1` }
}

const text = { type: 'text', text: 'Here you go.' }

/** Everything but text folds, which is what the view's predicate boils down to. */
const foldable = (part: unknown) => (part as { type?: string }).type !== 'text'

function group(parts: unknown[], live = false): TranscriptSegment[] {
  return groupTranscriptParts(parts, { messageId: 'm1', live, foldable })
}

function summaries(segments: TranscriptSegment[]): string[] {
  return segments.flatMap((segment) => (segment.kind === 'chain' ? [segment.summary] : []))
}

describe('groupTranscriptParts', () => {
  it('collapses a run of thinking and tool calls into one summary', () => {
    const segments = group([
      reasoning(4_000),
      tool('bash'),
      reasoning(2_300),
      tool('read'),
      tool('write'),
      text,
    ])

    expect(segments.map((segment) => segment.kind)).toEqual(['chain', 'part'])
    expect(summaries(segments)).toEqual(['Reasoned for 6.3 seconds, used 3 tools'])
  })

  it('starts a new chain after anything that interrupts the run', () => {
    const segments = group([reasoning(1_000), tool('bash'), text, reasoning(500), tool('read')])

    expect(segments.map((segment) => segment.kind)).toEqual(['chain', 'part', 'chain'])
    expect(summaries(segments)).toEqual([
      'Reasoned for 1.0 seconds, used 1 tool',
      'Reasoned for 0.5 seconds, used 1 tool',
    ])
  })

  it('leaves a lone part alone — its own card is already one line', () => {
    const segments = group([reasoning(1_000), text, tool('bash')])

    expect(segments.map((segment) => segment.kind)).toEqual(['part', 'part', 'part'])
  })

  it('shows the turn in flight in full, and folds it once it is over', () => {
    const parts = [reasoning(1_000), tool('bash'), reasoning(0, 'streaming')]

    expect(group(parts, true).map((segment) => segment.kind)).toEqual(['part', 'part', 'part'])
    expect(group(parts, false).map((segment) => segment.kind)).toEqual(['chain'])
  })

  it('folds an abandoned turn once it is no longer the live one', () => {
    // A cancelled turn leaves its last block streaming forever; keeping it
    // expanded would pin the noise of a dead turn to the transcript.
    const segments = group([reasoning(1_000), tool('bash', 'input-available')], false)

    expect(segments.map((segment) => segment.kind)).toEqual(['chain'])
  })

  it('names how many calls failed, so a fold never hides a broken run', () => {
    const segments = group([tool('write', 'output-error'), tool('write'), tool('bash')])

    expect(summaries(segments)).toEqual(['Used 3 tools (1 failed)'])
  })

  it('reports minutes for a long stretch of thinking', () => {
    const segments = group([reasoning(134_000), tool('bash')])

    expect(summaries(segments)).toEqual(['Reasoned for 2m 14s, used 1 tool'])
  })

  it('falls back to a step count for a transcript with no recorded timings', () => {
    const untimed = { type: 'reasoning', state: 'done' }

    expect(summaries(group([untimed, untimed]))).toEqual(['2 reasoning steps'])
  })

  it('keys segments per message so two turns never share DOM state', () => {
    const keys = (id: string) =>
      groupTranscriptParts([reasoning(1_000), tool('bash')], {
        messageId: id,
        live: false,
        foldable,
      }).map((segment) => segment.key)

    expect(keys('m1')).not.toEqual(keys('m2'))
  })
})

describe('part classification', () => {
  it('reads the tool name from either part encoding', () => {
    expect(toolPartNameOf(tool('bash'))).toBe('bash')
    expect(toolPartNameOf({ type: 'tool-media' })).toBe('media')
    expect(toolPartNameOf({ type: 'reasoning' })).toBeUndefined()
  })

  it('recognizes the bridged media tools', () => {
    expect(mediaToolNameOf({ type: 'tool-media' })).toBe('media')
    expect(mediaToolNameOf(tool('generateImage'))).toBe('generateImage')
    expect(mediaToolNameOf(tool('bash'))).toBeUndefined()
  })

  it('recognizes the synthetic compaction call', () => {
    const part = { ...tool('compaction'), output: { trigger: 'threshold', summary: 'so far…' } }

    expect(compactionOutputOf(part)?.trigger).toBe('threshold')
    expect(compactionOutputOf(tool('bash'))).toBeNull()
  })
})

describe('busyLabelOf', () => {
  it('names the in-flight part, and thinks after a finished tool', () => {
    expect(busyLabelOf([])).toBe('Agent is working…')
    expect(busyLabelOf([{ type: 'reasoning', state: 'streaming' }])).toBe('Thinking…')
    expect(busyLabelOf([{ type: 'text', state: 'streaming' }])).toBe('Writing response…')
    expect(
      busyLabelOf([
        {
          type: 'dynamic-tool',
          toolName: 'read',
          state: 'input-available',
          input: { file_path: 'game.js' },
        },
      ]),
    ).toBe('Reading game.js…')
    expect(busyLabelOf([tool('bash')])).toBe('Thinking…')
  })

  it('prefers a nested media step label over the generic media name', () => {
    expect(
      busyLabelOf(
        [
          {
            type: 'dynamic-tool',
            toolName: 'media',
            state: 'input-available',
            toolCallId: 'm1',
          },
        ],
        (id) => (id === 'm1' ? 'Generating image…' : undefined),
      ),
    ).toBe('Generating image…')
  })
})

describe('generatedMediaOf', () => {
  function mediaPart(name: string, output: unknown, state = 'output-available') {
    return { ...tool(name, state), output }
  }

  /** A Pi tool result as the session record saves it: the model's text plus `details`. */
  function piResult(details: unknown) {
    return { content: [{ type: 'text', text: '{"images":[]}' }], details }
  }

  const image = {
    id: 'a',
    type: 'image',
    imageUrl: 'aipg-media://a.png',
    mode: 'imageGen',
    settings: { seed: 1 },
    state: 'done',
  }
  const video = {
    id: 'b',
    type: 'video',
    videoUrl: 'aipg-media://b.mp4',
    mode: 'imageGen',
    settings: {},
    state: 'done',
  }

  it('returns the items a media tool put in its details', () => {
    const media = generatedMediaOf(mediaPart('generateImage', piResult({ items: [image, video] })))
    expect(media?.items).toEqual([image, video])
  })

  it('shows an edited image the same way', () => {
    const media = generatedMediaOf(mediaPart('editImage', piResult({ items: [image] })))
    expect(media?.items.map((item) => item.id)).toEqual(['a'])
  })

  it('carries the media specialist step lines', () => {
    const media = generatedMediaOf(
      mediaPart('media', piResult({ items: [image], steps: ['Picked Flux'] })),
    )
    expect(media?.steps).toEqual(['Picked Flux'])
  })

  it('drops items without a URL or of an unknown type', () => {
    const media = generatedMediaOf(
      mediaPart(
        'editImage',
        piResult({
          items: [image, { id: 'c', type: 'image' }, { id: 'd', type: 'audio', url: 'x' }, null],
        }),
      ),
    )
    expect(media?.items.map((item) => item.id)).toEqual(['a'])
  })

  it('ignores an images field outside details', () => {
    expect(generatedMediaOf(mediaPart('generateImage', { images: [image] }))).toBeUndefined()
  })

  it('shows nothing for a non-media tool', () => {
    expect(generatedMediaOf(mediaPart('bash', piResult({ items: [image] })))).toBeUndefined()
  })

  it('shows nothing while the tool is still running', () => {
    expect(
      generatedMediaOf(mediaPart('generateImage', undefined, 'input-available')),
    ).toBeUndefined()
  })

  it('shows nothing for a failed call', () => {
    const failed = { ...tool('generateImage', 'output-error'), errorText: 'boom' }
    expect(generatedMediaOf(failed)).toBeUndefined()
  })

  it('shows nothing for a text-only result saved before details existed', () => {
    const textOnly = {
      content: [{ type: 'text', text: '{"images":[{"imageUrl":"aipg-media://a.png"}]}' }],
    }
    expect(generatedMediaOf(mediaPart('generateImage', textOnly))).toBeUndefined()
    expect(generatedMediaOf(mediaPart('generateImage', piResult(undefined)))).toBeUndefined()
  })
})

describe('generatedMediaOf (speech)', () => {
  const clip = {
    savedFilePath: '/home/u/AI-Playground/audio/game_speech.wav',
    workspacePath: 'generated/speech.wav',
    message: 'Synthesized speech with Kokoro (Ryan).',
  }

  function speechPart(output: unknown, state = 'output-available') {
    return { ...tool('synthesizeTextToSpeech', state), output }
  }

  it('returns the app-folder clip a speech call put in its details', () => {
    const part = speechPart({
      content: [{ type: 'text', text: '{"ok":true}' }],
      details: { audio: clip },
    })
    expect(generatedMediaOf(part)).toEqual({ items: [], audio: clip })
  })

  it('counts text-to-speech as a media tool, so its card is never folded away', () => {
    expect(isGeneratedMediaTool(speechPart(undefined, 'input-available'))).toBe(true)
    expect(isGeneratedMediaTool(tool('generateImage'))).toBe(true)
    expect(isGeneratedMediaTool(tool('transcribeAudio'))).toBe(false)
  })

  it('shows nothing for a text-only speech result saved before details existed', () => {
    const textOnly = {
      content: [{ type: 'text', text: '{"ok":true,"savedFilePath":"generated/speech.wav"}' }],
    }
    expect(generatedMediaOf(speechPart(textOnly))).toBeUndefined()
  })

  it('shows nothing for a failed speech call or a clip without its app-folder copy', () => {
    expect(generatedMediaOf({ ...tool('synthesizeTextToSpeech', 'output-error') })).toBeUndefined()
    const noCopy = { details: { audio: { workspacePath: 'generated/speech.wav' } } }
    expect(generatedMediaOf(speechPart(noCopy))).toBeUndefined()
  })
})
