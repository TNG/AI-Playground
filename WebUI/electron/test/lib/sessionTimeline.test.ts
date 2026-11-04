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
    expect(turns[1]).toMatchObject({ id: 'u1', answers: [{ id: 'a1' }] })
    expect(turns[2]).toMatchObject({ id: 'u2', answers: [{ id: 'a2' }] })
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
        run.turns.map((turn) => [turn.id, ...turn.answers.map((m) => m.id)]),
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
        turn.kind === 'chat' ? [turn.id, ...turn.answers.map((m) => m.id)] : null,
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
      { kind: 'audio', id: 'a1', prompt: { text: 'Read this' }, createdAt: 1, audio },
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
      { kind: 'agent', id: 'u1', answers: [{ id: 'a1' }] },
      { kind: 'agent', id: 'u2', answers: [{ id: 'a2' }] },
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
    expect(turns[1]).toMatchObject({ id: 'u2', answers: [{ id: 'a2' }] })
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
    expect(chat).toMatchObject({ kind: 'chat', id: 'u1', answers: [{ id: 'a1' }] })
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
      prompt: { text: 'hi' },
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
    expect(items[1]).toMatchObject({ id: 'u8', streaming: false })
    expect(items[2]).toMatchObject({ id: 'u9', streaming: true })
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
      { kind: 'agent', id: 'u1', answers: [{ id: 'a1' }], queued: false },
      { kind: 'agent', id: 'u2', answers: [], queued: true },
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
      { id: 'u2', notRun: true, canResend: true },
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

describe('the user bubble of every Turn', () => {
  const mediaTurn = (mode: string, prompt: string, items: object[]) => [
    { ...mediaPrompt, parts: prompt ? [{ type: 'text', text: prompt }] : [] },
    {
      ...mediaCard,
      parts: [
        {
          type: 'data-media',
          data: { runId: 'r1', mode, preset: 'Wan', status: 'completed', items },
        },
      ],
    },
  ]
  const editedItem = (current: string) => ({
    id: 'i1',
    state: 'done',
    mode: 'imageEdit',
    imageUrl: 'aipg-media://sessions/s1/files/out.png',
    settings: {},
    dynamicSettings: [
      { label: 'Strength', type: 'number', current: 0.5 },
      { label: 'Image', type: 'image', current },
    ],
  })

  it('shows a ComfyUI prompt like a chat prompt', () => {
    const [turn] = timelineTurns([mediaPrompt, mediaCard])

    expect(turn).toMatchObject({ prompt: { text: 'a castle' } })
    expect(turn.kind === 'media' && turn.prompt.inputImageUrl).toBeUndefined()
  })

  it('shows the input image of an Image Edit Turn', () => {
    const [turn] = timelineTurns(
      mediaTurn('imageEdit', 'make it blue', [editedItem('aipg-media://sessions/s1/files/in.png')]),
    )

    expect(turn).toMatchObject({
      prompt: { text: 'make it blue', inputImageUrl: 'aipg-media://sessions/s1/files/in.png' },
    })
  })

  it('shows the input image of a Video Turn', () => {
    const [turn] = timelineTurns(
      mediaTurn('video', 'pan left', [
        { ...editedItem('aipg-media://media/in.png'), mode: 'video' },
      ]),
    )

    expect(turn).toMatchObject({ prompt: { inputImageUrl: 'aipg-media://media/in.png' } })
  })

  it('shows no input image when the Session could not keep it', () => {
    const [turn] = timelineTurns(mediaTurn('imageEdit', 'make it blue', [editedItem('')]))

    expect(turn.kind === 'media' && turn.prompt.inputImageUrl).toBeUndefined()
  })

  it('names the preset in place of a ComfyUI prompt that was left empty', () => {
    const [turn] = timelineTurns(mediaTurn('imageEdit', '', []))

    expect(turn).toMatchObject({ prompt: { text: '', placeholder: 'Wan' } })
  })

  it('shows the input image of a ComfyUI run still in flight', () => {
    const items = sessionTimelineItems([], {
      media: {
        runId: 'r2',
        prompt: '',
        preset: 'Wan',
        mode: 'video' as const,
        inputImageUrl: 'aipg-media://media/in.png',
      },
    })

    expect(items).toMatchObject([
      {
        kind: 'pending-media',
        prompt: { text: '', placeholder: 'Wan', inputImageUrl: 'aipg-media://media/in.png' },
      },
    ])
  })

  it("shows a chat prompt's text and its attached image", () => {
    const [turn] = timelineTurns([
      {
        ...chatMessage('u1', 'user', 'what is this?'),
        parts: [
          { type: 'file', mediaType: 'image/png', url: 'data:image/png;base64,AAA' },
          { type: 'text', text: 'what is this?' },
        ],
      },
    ])

    expect(turn).toMatchObject({
      prompt: { text: 'what is this?', inputImageUrl: 'data:image/png;base64,AAA' },
    })
  })

  it('shows an agent prompt with the channel it came from', () => {
    const [turn] = timelineTurns([
      { ...agentMessage('u1', 'user', 'hi'), metadata: { agentTurn, origin: 'telegram' } },
    ])

    expect(turn).toMatchObject({ prompt: { text: 'hi', origin: 'telegram' } })
  })

  it('shows the source audio of a speech-to-text Turn, named by its preset', () => {
    const stt = { kind: 'stt', preset: 'Speech to Text', status: 'completed', audioUrl: 'clip' }
    const [turn] = timelineTurns([
      { ...user('u1', ''), parts: [] },
      { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'data-audio', data: stt }] },
    ])

    expect(turn).toMatchObject({
      prompt: { text: '', placeholder: 'Speech to Text', audio: [{ url: 'clip' }] },
    })
  })
})

describe('the footer of every Turn', () => {
  const actionsOf = (item: unknown) => (item as { footer: { actions: string[] } }).footer.actions
  const timings = { predicted_n: 12, predicted_per_second: 30, prompt_ms: 40 }
  const pendingMedia = {
    runId: 'r2',
    prompt: 'a dragon',
    preset: 'Draft',
    mode: 'imageGen' as const,
  }

  it('offers Copy, Speak, Regenerate and Delete on the last chat Turn', () => {
    const items = sessionTimelineItems(
      [chatMessage('u1', 'user', 'hi'), chatMessage('a1', 'assistant', 'hello')],
      {},
    )

    expect(items[0]).toMatchObject({
      footer: {
        actions: ['copy', 'speak', 'regenerate', 'delete'],
        text: 'hello',
        messageId: 'a1',
      },
    })
  })

  it('offers Regenerate on the last chat Turn only', () => {
    const items = sessionTimelineItems(
      [
        chatMessage('u1', 'user', 'hi'),
        chatMessage('a1', 'assistant', 'hello'),
        chatMessage('u2', 'user', 'again'),
        chatMessage('a2', 'assistant', 'hello again'),
      ],
      {},
    )

    expect(items.map(actionsOf)).toEqual([
      ['copy', 'speak', 'delete'],
      ['copy', 'speak', 'regenerate', 'delete'],
    ])
  })

  it('offers no Regenerate on a chat Turn that another Turn followed', () => {
    const items = sessionTimelineItems(
      [chatMessage('u1', 'user', 'hi'), chatMessage('a1', 'assistant', 'hello')],
      { media: pendingMedia },
    )

    expect(actionsOf(items[0])).toEqual(['copy', 'speak', 'delete'])
  })

  it('offers nothing on a chat prompt still waiting for its answer', () => {
    const items = sessionTimelineItems([chatMessage('u1', 'user', 'hi')], {})

    expect(actionsOf(items[0])).toEqual([])
  })

  it('offers nothing on a chat answer that has shown nothing yet', () => {
    const answer = { id: 'a1', role: 'assistant', parts: [] }
    const items = sessionTimelineItems([chatMessage('u1', 'user', 'hi')], {
      chat: [chatMessage('u1', 'user', 'hi'), answer],
    })

    expect(actionsOf(items[0])).toEqual([])
  })

  it('offers Delete without Copy on a chat answer that only called a tool', () => {
    const tool = { type: 'tool-comfyUI', toolCallId: 't1', state: 'input-available', input: {} }
    const answer = { id: 'a1', role: 'assistant', parts: [tool] }
    const items = sessionTimelineItems([chatMessage('u1', 'user', 'hi')], {
      chat: [chatMessage('u1', 'user', 'hi'), answer],
    })

    expect(actionsOf(items[0])).toEqual(['regenerate', 'delete'])
  })

  it("carries a chat answer's metrics", () => {
    const answer = {
      ...chatMessage('a1', 'assistant', 'hello'),
      metadata: { chatTurn: true, timings },
    }
    const items = sessionTimelineItems([chatMessage('u1', 'user', 'hi'), answer], {})

    expect(items[0]).toMatchObject({ footer: { metrics: { timings } } })
  })

  it('offers only Copy on an Agent Preset Turn, without metrics', () => {
    const answer = {
      ...agentMessage('a1', 'assistant', 'built it'),
      metadata: { agentTurn, timings },
    }
    const items = sessionTimelineItems([agentMessage('u1', 'user', 'make a game'), answer], {})

    expect(items[0]).toMatchObject({ footer: { actions: ['copy'], text: 'built it' } })
    expect(items[0]).not.toHaveProperty('footer.metrics')
  })

  it('offers nothing on an Agent Preset Turn with no text yet', () => {
    const items = sessionTimelineItems([agentMessage('u1', 'user', 'make a game')], {})

    expect(actionsOf(items[0])).toEqual([])
  })

  it('offers Copy of the transcript on a speech-to-text Turn', () => {
    const stt = { kind: 'stt', preset: 'Speech to Text', status: 'completed', transcript: 'hello' }
    const items = sessionTimelineItems(
      [
        user('u1', ''),
        { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'data-audio', data: stt }] },
      ],
      {},
    )

    expect(items[0]).toMatchObject({ footer: { actions: ['copy'], text: 'hello' } })
  })

  it('offers nothing on ComfyUI, text-to-speech and running Turns, which have no text', () => {
    const tts = { kind: 'tts', preset: 'Text to Speech', status: 'completed', audioUrl: 'u' }
    const items = sessionTimelineItems(
      [
        mediaPrompt,
        mediaCard,
        user('u1', 'Read this'),
        { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'data-audio', data: tts }] },
      ],
      {
        media: pendingMedia,
        audio: { kind: 'tts' as const, prompt: 'hi', preset: 'Text to Speech' },
      },
    )

    expect(items.map(actionsOf)).toEqual([[], [], [], []])
  })
})
