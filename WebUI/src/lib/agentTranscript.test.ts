import { describe, expect, it } from 'vitest'
import {
  compactionOutputOf,
  generatedMediaOf,
  mediaFileRefOf,
  transcriptMediaItems,
  mediaToolNameOf,
  toolPartNameOf,
  busyLabelOf,
  settleStreamingParts,
} from './agentTranscript'

function tool(name: string, state = 'output-available') {
  return { type: 'dynamic-tool', toolName: name, state, toolCallId: `${name}-1` }
}

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

  it('shows the video and 3D model a media specialist run produced, with its steps', () => {
    const model = {
      id: 'c',
      type: 'model3d',
      model3dUrl: 'aipg-media://c.glb',
      mode: 'imageGen',
      settings: {},
      state: 'done',
    }
    const steps = [
      'comfyUI (Dummy Video): produced 1 video',
      'comfyUI (Dummy 3D): produced 1 model3d',
    ]
    const media = generatedMediaOf(mediaPart('media', piResult({ items: [video, model], steps })))
    expect(media).toEqual({ items: [video, model], steps })
  })

  it('keeps the steps of a specialist run that produced nothing', () => {
    const steps = ['comfyUI (W1): failed — oom']
    expect(generatedMediaOf(mediaPart('media', piResult({ items: [], steps })))).toEqual({
      items: [],
      steps,
    })
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

  it('keeps where each item landed in the workspace', () => {
    const saved = { ...image, workspacePath: 'generated/a.png' }
    const media = generatedMediaOf(mediaPart('generateImage', piResult({ items: [saved, video] })))
    expect(media?.items.map((item) => item.workspacePath)).toEqual(['generated/a.png', undefined])
  })

  it('drops items that did not finish', () => {
    const pending = { ...image, id: 'p', state: 'generating' }
    const media = generatedMediaOf(
      mediaPart('generateImage', piResult({ items: [image, pending] })),
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

describe('transcriptMediaItems', () => {
  const finished = {
    id: 'a',
    type: 'image',
    imageUrl: 'aipg-media://a.png',
    mode: 'imageGen',
    settings: {},
    state: 'done',
  }
  const live = [{ ...finished, id: 'live', state: 'generating' }] as never[]

  function part(state: string, output?: unknown) {
    return { ...tool('generateImage', state), output }
  }

  it('shows the finished items from the result', () => {
    const done = part('output-available', { content: [], details: { items: [finished] } })
    expect(transcriptMediaItems(done, live).map((item) => item.id)).toEqual(['a'])
  })

  it('shows what the run has so far while the tool is running', () => {
    expect(transcriptMediaItems(part('input-available'), live)).toBe(live)
    expect(transcriptMediaItems(part('input-streaming'), live)).toBe(live)
  })

  it('shows no media for a failed call or a finished one without items', () => {
    expect(transcriptMediaItems({ ...part('output-error'), errorText: 'boom' }, live)).toEqual([])
    expect(transcriptMediaItems(part('output-available', { content: [] }), live)).toEqual([])
  })
})

describe('mediaFileRefOf', () => {
  const image = {
    id: 'a',
    type: 'image' as const,
    imageUrl: 'aipg-media://media/castle.png',
    mode: 'imageGen' as const,
    settings: {},
    state: 'done' as const,
  }

  it('targets the workspace copy of an item, with its app copy as the fallback', () => {
    expect(
      mediaFileRefOf('session-1', { ...image, workspacePath: 'generated/castle.png' }),
    ).toEqual({
      sessionId: 'session-1',
      workspacePath: 'generated/castle.png',
      appCopy: 'aipg-media://media/castle.png',
    })
  })

  it('falls back to the app copy alone when the tool saved no workspace copy', () => {
    const model = {
      ...image,
      type: 'model3d' as const,
      imageUrl: undefined,
      model3dUrl: 'aipg-media://media/shape.glb',
    }
    expect(mediaFileRefOf('session-1', model)).toEqual({
      sessionId: 'session-1',
      appCopy: 'aipg-media://media/shape.glb',
    })
  })

  it('targets the workspace copy of a speech clip', () => {
    const clip = {
      savedFilePath: '/home/u/AI-Playground/audio/game_speech.wav',
      workspacePath: 'generated/speech.wav',
    }
    expect(mediaFileRefOf('session-1', clip)).toEqual({
      sessionId: 'session-1',
      workspacePath: 'generated/speech.wav',
      appCopy: '/home/u/AI-Playground/audio/game_speech.wav',
    })
  })
})

describe('settleStreamingParts', () => {
  const live = (parts: unknown[]) => [{ id: 'a1', role: 'assistant', parts }]

  it('ends a stopped reasoning block at the stop', () => {
    const reasoning = {
      type: 'reasoning',
      text: 'hm',
      state: 'streaming',
      providerMetadata: { aipg: { reasoningStarted: 1_000 } },
    }

    const [message] = settleStreamingParts(live([reasoning]), 4_000)

    expect(message.parts[0]).toEqual({
      ...reasoning,
      state: 'done',
      providerMetadata: { aipg: { reasoningStarted: 1_000, reasoningFinished: 4_000 } },
    })
  })

  it('invents no duration without a stop time, and keeps one already measured', () => {
    const open = {
      type: 'reasoning',
      state: 'streaming',
      providerMetadata: { aipg: { reasoningStarted: 1_000 } },
    }
    const measured = {
      type: 'reasoning',
      state: 'streaming',
      providerMetadata: { aipg: { reasoningStarted: 1_000, reasoningFinished: 2_000 } },
    }

    expect(settleStreamingParts(live([open]))[0].parts[0]).toEqual({ ...open, state: 'done' })
    expect(settleStreamingParts(live([measured]), 9_000)[0].parts[0]).toEqual({
      ...measured,
      state: 'done',
    })
  })

  it('settles streaming text and leaves other parts and messages untouched', () => {
    const tool = { type: 'tool-bash', state: 'output-available' }
    const settledMessage = { id: 'u1', role: 'user', parts: [{ type: 'text', state: 'done' }] }
    const messages = [settledMessage, ...live([{ type: 'text', state: 'streaming' }, tool])]

    const [user, assistant] = settleStreamingParts(messages, 4_000)

    expect(user).toBe(settledMessage)
    expect(assistant.parts).toEqual([{ type: 'text', state: 'done' }, tool])
  })
})
