import { describe, expect, it } from 'vitest'
import { sessionTimelineItems, timelineTurns, withLiveAgentTurn } from '@/lib/sessionTimeline'

const agentTurn = { presetName: 'Agent', harnessSessionId: 'aipg-agent-1' }

function agentMessage(id: string, role: 'user' | 'assistant', text: string) {
  return { id, role, parts: [{ type: 'text', text }], metadata: { agentTurn } }
}

const mediaPrompt = {
  id: 'p1',
  role: 'user',
  createdAt: 1,
  parts: [{ type: 'text', text: 'a castle' }],
}
const mediaCard = {
  id: 'c1',
  role: 'assistant',
  createdAt: 1,
  parts: [
    {
      type: 'data-media',
      data: { runId: 'r1', mode: 'imageGen', preset: 'Draft', status: 'completed', items: [] },
    },
  ],
}

describe('Session timeline turns', () => {
  it('starts a Turn for every prompt to one Agent Preset', () => {
    const turns = timelineTurns([
      mediaPrompt,
      mediaCard,
      agentMessage('u1', 'user', 'describe it'),
      agentMessage('a1', 'assistant', 'a castle'),
      agentMessage('u2', 'user', 'make it blue'),
      agentMessage('a2', 'assistant', 'done'),
    ])

    expect(turns.map((turn) => turn.kind)).toEqual(['media', 'agent', 'agent'])
    expect(turns[1]).toMatchObject({ prompt: { id: 'u1' }, answers: [{ id: 'a1' }] })
    expect(turns[2]).toMatchObject({ prompt: { id: 'u2' }, answers: [{ id: 'a2' }] })
  })

  it('starts a new agent block after a turn of another preset', () => {
    const turns = timelineTurns([
      agentMessage('u1', 'user', 'hello'),
      agentMessage('a1', 'assistant', 'hi'),
      mediaPrompt,
      mediaCard,
      agentMessage('u2', 'user', 'and now?'),
    ])

    expect(turns.map((turn) => turn.kind)).toEqual(['agent', 'media', 'agent'])
  })
})

const user = (id: string, text: string) => ({
  id,
  role: 'user',
  createdAt: 1,
  parts: [{ type: 'text', text }],
})

const chatMessage = (id: string, role: 'user' | 'assistant', text: string) => ({
  id,
  role,
  parts: [{ type: 'text', text }],
  metadata: { chatTurn: true },
})

describe('Task Runs in the timeline', () => {
  const taskRunTag = {
    presetName: 'Agent',
    harnessSessionId: 'aipg-agent-run',
    taskRun: { taskName: 'Morning digest', startedAt: 500 },
  }
  const runMessage = (id: string, role: 'user' | 'assistant') => ({
    id,
    role,
    parts: [{ type: 'text', text: id }],
    metadata: { agentTurn: taskRunTag },
  })

  it("groups a run's Steps under its Task name and start time, apart from the Agent's own turns", () => {
    const turns = timelineTurns([
      agentMessage('u1', 'user', 'hello'),
      agentMessage('a1', 'assistant', 'hi'),
      runMessage('r1', 'user'),
      runMessage('r2', 'assistant'),
      runMessage('r3', 'user'),
      runMessage('r4', 'assistant'),
    ])

    expect(turns.map((turn) => turn.kind)).toEqual(['agent', 'task-run'])
    expect(turns[0]).not.toHaveProperty('taskRun')
    const run = turns[1]
    expect(run).toMatchObject({
      kind: 'task-run',
      taskRun: { taskName: 'Morning digest', startedAt: 500 },
    })
    expect(
      run.kind === 'task-run' &&
        run.turns.map((turn) => [turn.prompt?.id, ...turn.answers.map((m) => m.id)]),
    ).toEqual([
      ['r1', 'r2'],
      ['r3', 'r4'],
    ])
  })
})

describe('chat turns in the timeline', () => {
  it('starts a Turn for every chat prompt, each holding its own answer', () => {
    const turns = timelineTurns([
      chatMessage('u1', 'user', 'hi'),
      chatMessage('a1', 'assistant', 'hello'),
      mediaPrompt,
      mediaCard,
      chatMessage('u2', 'user', 'describe it'),
      chatMessage('a2', 'assistant', 'a fox'),
      chatMessage('u3', 'user', 'and its tail?'),
      chatMessage('a3', 'assistant', 'bushy'),
    ])

    expect(turns.map((turn) => turn.kind)).toEqual(['chat', 'media', 'chat', 'chat'])
    expect(
      turns.map((turn) =>
        turn.kind === 'chat' ? [turn.prompt?.id, ...turn.answers.map((m) => m.id)] : null,
      ),
    ).toEqual([['u1', 'a1'], null, ['u2', 'a2'], ['u3', 'a3']])
  })
})

describe('timelineTurns', () => {
  it('pairs a prompt with its audio result into one audio turn', () => {
    const audio = { kind: 'tts', preset: 'Text to Speech', status: 'completed', audioUrl: 'u' }
    const turns = timelineTurns([
      user('u1', 'Read this'),
      { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'data-audio', data: audio }] },
    ])

    expect(turns).toMatchObject([
      { kind: 'audio', id: 'a1', prompt: 'Read this', createdAt: 1, audio },
    ])
  })

  it('keeps a prompt with a plain text answer as two messages', () => {
    const turns = timelineTurns([
      user('u1', 'hi'),
      { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'text', text: 'hello' }] },
    ])

    expect(turns.map((turn) => turn.kind)).toEqual(['message', 'message'])
  })
})

describe('the live agent turn in the Session timeline', () => {
  const live = (id: string, role: 'user' | 'assistant', text: string) => ({
    id,
    role,
    parts: [{ type: 'text', text }],
  })

  it('streams the running turn after everything the Session already settled', () => {
    const timeline = withLiveAgentTurn(
      [agentMessage('u1', 'user', 'describe it'), agentMessage('a1', 'assistant', 'a castle')],
      agentTurn,
      [
        live('u1', 'user', 'describe it'),
        live('a1', 'assistant', 'a castle'),
        live('u2', 'user', 'make it blue'),
        live('a2', 'assistant', 'paint'),
      ],
    )

    const turns = timelineTurns(timeline)
    expect(turns).toMatchObject([
      { kind: 'agent', prompt: { id: 'u1' }, answers: [{ id: 'a1' }] },
      { kind: 'agent', prompt: { id: 'u2' }, answers: [{ id: 'a2' }] },
    ])
  })

  it('shows the streaming copy of a message the Session saved earlier in the turn', () => {
    const timeline = withLiveAgentTurn(
      [mediaPrompt, mediaCard, agentMessage('u2', 'user', 'make it blue')],
      agentTurn,
      [live('u2', 'user', 'make it blue'), live('a2', 'assistant', 'painting…')],
    )

    const turns = timelineTurns(timeline)
    expect(turns.map((turn) => turn.kind)).toEqual(['media', 'agent'])
    expect(turns[1]).toMatchObject({ prompt: { id: 'u2' }, answers: [{ id: 'a2' }] })
  })

  it('leaves the timeline as it is with nothing live', () => {
    const timeline = [mediaPrompt, mediaCard]
    expect(withLiveAgentTurn(timeline, agentTurn, [])).toEqual(timeline)
  })
})

describe('the one Session timeline with every live turn in it', () => {
  const live = (id: string, role: 'user' | 'assistant', text: string) => ({
    id,
    role,
    parts: [{ type: 'text', text }],
  })
  const pendingMedia = {
    runId: 'r2',
    prompt: 'a dragon',
    preset: 'Draft',
    mode: 'imageGen' as const,
  }
  const pendingAudio = { kind: 'tts' as const, prompt: 'read this', preset: 'Text to Speech' }
  const kinds = (items: { kind: string }[]) => items.map((item) => item.kind)

  it('shows a media run in flight after a streaming chat turn of the same Session', () => {
    const items = sessionTimelineItems([chatMessage('u1', 'user', 'hi')], {
      chat: [live('u1', 'user', 'hi'), live('a1', 'assistant', 'hel')],
      media: pendingMedia,
    })

    expect(kinds(items)).toEqual(['chat', 'pending-media'])
    expect(items[1]).toMatchObject({ kind: 'pending-media', id: 'r2', pending: pendingMedia })
  })

  it('shows a streaming chat turn that the Session has not saved yet, after its media turns', () => {
    const items = sessionTimelineItems([mediaPrompt, mediaCard], {
      chat: [live('u1', 'user', 'describe it'), live('a1', 'assistant', 'a cas')],
    })

    expect(kinds(items)).toEqual(['media', 'chat'])
    const chat = items[1]
    expect(chat).toMatchObject({ kind: 'chat', prompt: { id: 'u1' }, answers: [{ id: 'a1' }] })
  })

  it('shows the live copy of a saved chat message in place, once', () => {
    const items = sessionTimelineItems(
      [
        chatMessage('u1', 'user', 'hi'),
        chatMessage('a1', 'assistant', 'hel'),
        mediaPrompt,
        mediaCard,
      ],
      { chat: [live('u1', 'user', 'hi'), live('a1', 'assistant', 'hello there')] },
    )

    expect(kinds(items)).toEqual(['chat', 'media'])
    const chat = items[0]
    expect(chat).toMatchObject({
      prompt: { parts: [{ type: 'text', text: 'hi' }] },
      answers: [{ parts: [{ type: 'text', text: 'hello there' }] }],
    })
  })

  it('drops the in-flight media run once its result card is in the timeline', () => {
    const items = sessionTimelineItems([mediaPrompt, mediaCard], {
      media: { ...pendingMedia, runId: 'r1' },
    })

    expect(kinds(items)).toEqual(['media'])
  })

  it('shows the running agent turn and marks it as the one streaming', () => {
    const running = {
      tag: agentTurn,
      messages: [
        live('u8', 'user', 'hi'),
        live('a8', 'assistant', 'hey'),
        live('u9', 'user', 'go'),
      ],
      live: true,
    }
    const items = sessionTimelineItems([mediaPrompt, mediaCard], { agents: [running] })

    expect(kinds(items)).toEqual(['media', 'agent', 'agent'])
    expect(items[1]).toMatchObject({ prompt: { id: 'u8' }, streaming: false })
    expect(items[2]).toMatchObject({ prompt: { id: 'u9' }, streaming: true })
  })

  it('shows a queued agent prompt as its own Turn after the answered one', () => {
    const items = sessionTimelineItems([], {
      agents: [
        {
          tag: agentTurn,
          messages: [
            live('u1', 'user', 'make a ship'),
            live('a1', 'assistant', 'here it is'),
            live('u2', 'user', 'now a rock'),
          ],
          live: true,
          queuedMessageId: 'u2',
        },
      ],
    })

    expect(items).toMatchObject([
      { kind: 'agent', prompt: { id: 'u1' }, answers: [{ id: 'a1' }], queued: false },
      { kind: 'agent', prompt: { id: 'u2' }, answers: [], queued: true },
    ])
  })

  it('offers Resend on the not-run agent prompt that ends the Session', () => {
    const items = sessionTimelineItems([], {
      agents: [
        {
          tag: agentTurn,
          messages: [
            live('u1', 'user', 'hi'),
            live('a1', 'assistant', 'hey'),
            live('u2', 'user', 'go'),
          ],
          live: false,
          notRunMessageId: 'u2',
          canResend: true,
        },
      ],
    })

    expect(items).toMatchObject([
      { notRun: false, canResend: false },
      { prompt: { id: 'u2' }, notRun: true, canResend: true },
    ])
  })

  it("streams a Task Run's Step beside the Agent's own Harness Session", () => {
    const taskRun = { taskName: 'Morning digest', startedAt: 500 }
    const items = sessionTimelineItems([agentMessage('u1', 'user', 'hello')], {
      agents: [
        { tag: agentTurn, messages: [live('u1', 'user', 'hello')], live: false },
        {
          tag: { presetName: 'Agent', harnessSessionId: 'aipg-agent-run', taskRun },
          messages: [live('s1', 'user', 'step one')],
          live: true,
        },
      ],
    })

    expect(kinds(items)).toEqual(['agent', 'task-run'])
    expect(items[1]).toMatchObject({ kind: 'task-run', taskRun, live: true })
  })

  it('ends with the audio turn still running', () => {
    const items = sessionTimelineItems([mediaPrompt, mediaCard], { audio: pendingAudio })

    expect(kinds(items)).toEqual(['media', 'pending-audio'])
  })
})

describe('the hint on every Turn', () => {
  const answer = (id: string, metadata: object) => ({
    id,
    role: 'assistant',
    parts: [{ type: 'text', text: 'ok' }],
    metadata,
  })
  const mediaTurn = (mode: string, extra: object = {}) => [
    mediaPrompt,
    {
      ...mediaCard,
      parts: [
        {
          type: 'data-media',
          data: {
            runId: 'r1',
            mode,
            preset: 'Flux Schnell',
            status: 'completed',
            items: [],
            ...extra,
          },
        },
      ],
    },
  ]
  const audioTurn = (audio: object) => [
    user('u1', 'Read this'),
    { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'data-audio', data: audio }] },
  ]

  it('names the chat preset, with the model on hover', () => {
    const [turn] = timelineTurns([
      chatMessage('u1', 'user', 'hi'),
      answer('a1', { chatTurn: true, preset: 'Reasoning', model: 'unsloth/Qwen3-8B-Q4_K_M.gguf' }),
    ])

    expect(turn).toMatchObject({
      hint: { kind: 'chat', icon: 'chat', preset: 'Reasoning', detail: 'Qwen3-8B-Q4_K_M' },
    })
  })

  it('names a chat Turn saved before presets were recorded by its model', () => {
    const [turn] = timelineTurns([
      chatMessage('u1', 'user', 'hi'),
      answer('a1', { chatTurn: true, model: 'gpt-4o' }),
    ])

    expect(turn).toMatchObject({ hint: { kind: 'chat', preset: 'gpt-4o' } })
    expect(turn.kind === 'chat' && turn.hint.detail).toBeUndefined()
  })

  it('names the chat preset of a prompt still waiting for its answer', () => {
    const prompt = chatMessage('u1', 'user', 'hi')
    const [turn] = timelineTurns([
      { ...prompt, metadata: { chatTurn: true, preset: 'Reasoning', model: 'gpt-4o' } },
    ])

    expect(turn).toMatchObject({ hint: { preset: 'Reasoning', detail: 'gpt-4o' } })
  })

  it('names a chat Turn still waiting for its answer as Chat', () => {
    const [turn] = timelineTurns([chatMessage('u1', 'user', 'hi')])

    expect(turn).toMatchObject({ hint: { kind: 'chat', icon: 'chat', preset: 'Chat' } })
  })

  it('names the Agent Preset, with the model on hover', () => {
    const [turn] = timelineTurns([
      agentMessage('u1', 'user', 'make a game'),
      {
        ...agentMessage('a1', 'assistant', 'done'),
        metadata: { agentTurn, model: 'Qwen3.8-27B' },
      },
    ])

    expect(turn).toMatchObject({
      hint: { kind: 'agent', icon: 'agent', preset: 'Agent', detail: 'Qwen3.8-27B' },
    })
  })

  it('names the Agent Preset of a Turn saved before its model was recorded', () => {
    const [turn] = timelineTurns([agentMessage('u1', 'user', 'hi')])

    expect(turn).toMatchObject({ hint: { kind: 'agent', preset: 'Agent' } })
    expect(turn.kind === 'agent' && turn.hint.detail).toBeUndefined()
  })

  it('names the Agent Preset of each Turn inside a Task Run', () => {
    const tag = { ...agentTurn, presetName: 'Digest', taskRun: { taskName: 'Daily', startedAt: 1 } }
    const [run] = timelineTurns([
      { ...agentMessage('u1', 'user', 'go'), metadata: { agentTurn: tag } },
    ])

    expect(run.kind === 'task-run' && run.turns[0].hint).toMatchObject({
      kind: 'agent',
      preset: 'Digest',
    })
  })

  it('shows an image workflow with its preset, and its variant on hover', () => {
    const [turn] = timelineTurns(mediaTurn('imageEdit', { variant: 'Fast' }))

    expect(turn).toMatchObject({
      hint: { kind: 'workflow', icon: 'image', preset: 'Flux Schnell', detail: 'Fast' },
    })
  })

  it('shows a video workflow with a film icon', () => {
    const [turn] = timelineTurns(mediaTurn('video'))

    expect(turn).toMatchObject({
      hint: { kind: 'workflow', icon: 'video', preset: 'Flux Schnell' },
    })
  })

  it('shows text-to-speech with its preset, and the engine on hover', () => {
    const [turn] = timelineTurns(
      audioTurn({ kind: 'tts', preset: 'Text to Speech', status: 'completed', engine: 'Kokoro' }),
    )

    expect(turn).toMatchObject({
      hint: { kind: 'speech', icon: 'tts', preset: 'Text to Speech', detail: 'Kokoro' },
    })
  })

  it('shows speech-to-text with a microphone icon and its engine', () => {
    const [turn] = timelineTurns(
      audioTurn({ kind: 'stt', preset: 'Speech to Text', status: 'completed', engine: 'Whisper' }),
    )

    expect(turn).toMatchObject({
      hint: { kind: 'speech', icon: 'stt', preset: 'Speech to Text', detail: 'Whisper' },
    })
  })

  it('shows the hint on ComfyUI and audio Turns still running', () => {
    const items = sessionTimelineItems([], {
      media: { runId: 'r2', prompt: 'a dragon', preset: 'Wan', mode: 'video' },
      audio: { kind: 'stt', prompt: '', preset: 'Speech to Text' },
    })

    expect(items).toMatchObject([
      { kind: 'pending-media', hint: { kind: 'workflow', icon: 'video', preset: 'Wan' } },
      { kind: 'pending-audio', hint: { kind: 'speech', icon: 'stt', preset: 'Speech to Text' } },
    ])
  })
})
