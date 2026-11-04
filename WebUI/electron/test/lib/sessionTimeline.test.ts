import { describe, expect, it } from 'vitest'
import type { ArtifactRunsState, ArtifactRunView } from '@/lib/artifactRunProjection'
import { sessionTimelineItems, timelineTurns, withLiveAgentTurn } from '@/lib/sessionTimeline'
import { turnDetailsShown, turnDetailsSummaryText, turnLiveText } from '@/lib/turnText'
import type { SessionTimelineItem, TurnDetails, TurnResultPart } from '@/lib/turnTypes'
import type { AudioArtifact } from '@/lib/audioArtifacts'
import { artifactFrameSize, artifactGrid, type TurnArtifact } from '@/lib/turnArtifacts'
import type { ArtifactRunOwner } from '@/types/kernelEvents'
import type { MediaItem } from '@/types/mediaItem'

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

  it("shows the Results of a collapsed run's Turns: its artifacts and prose, not how it got there", () => {
    const [run] = timelineTurns([
      runMessage('r1', 'user'),
      {
        id: 'r2',
        role: 'assistant',
        metadata: { agentTurn: taskRunTag },
        parts: [
          { type: 'reasoning', text: 'plan the image', state: 'done' },
          {
            type: 'dynamic-tool',
            toolName: 'generateImage',
            toolCallId: 't1',
            state: 'output-available',
            input: { prompt: 'sunrise' },
            output: { content: [], details: { items: [] } },
          },
          { type: 'text', text: 'Here is your sunrise.' },
        ],
      },
      runMessage('r3', 'user'),
    ])

    expect(
      run.kind === 'task-run' && run.resultTurns.map((turn) => [turn.id, turn.result]),
    ).toEqual([
      [
        'r1',
        [
          { kind: 'artifact', messageId: 'r2', index: 1 },
          { kind: 'prose', messageId: 'r2', index: 2 },
        ],
      ],
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

const labels = {
  reasoned: 'Reasoned {duration}',
  reasonedUntimed: 'Reasoned',
  tool: '1 tool',
  tools: '{count} tools',
  image: '1 image',
  images: '{count} images',
  video: '1 video',
  videos: '{count} videos',
  model3d: '1 3D model',
  models3d: '{count} 3D models',
  audio: '1 audio clip',
  audios: '{count} audio clips',
  seed: 'seed {seed}',
}

describe('Turn Details and the Result', () => {
  const reasoning = (ms: number) => ({
    type: 'reasoning',
    text: 'thinking',
    state: 'done',
    providerMetadata: { aipg: { reasoningStarted: 1000, reasoningFinished: 1000 + ms } },
  })
  const text = (value: string) => ({ type: 'text', text: value })
  const image = (url: string, extra: object = {}) => ({
    id: url,
    type: 'image',
    state: 'done',
    imageUrl: url,
    ...extra,
  })
  const chatImageTool = (id: string, url: string) => ({
    type: 'tool-comfyUI',
    toolCallId: id,
    state: 'output-available',
    input: { workflow: 'Flux Schnell', prompt: 'a red ship' },
    output: { images: [image(url)] },
  })
  const agentImageTool = (id: string, url: string, workspacePath?: string) => ({
    type: 'dynamic-tool',
    toolName: 'generateImage',
    toolCallId: id,
    state: 'output-available',
    input: { prompt: 'a red ship' },
    output: { details: { items: [image(url, workspacePath ? { workspacePath } : {})] } },
  })
  const tool = (name: string) => ({
    type: 'dynamic-tool',
    toolName: name,
    toolCallId: `call-${name}`,
    state: 'output-available',
    input: {},
    output: {},
  })
  const chatTurn = (parts: object[]) =>
    timelineTurns([
      chatMessage('u1', 'user', 'draw a ship'),
      { id: 'a1', role: 'assistant', parts, metadata: { chatTurn: true } },
    ])[0]
  const agentTurnWith = (parts: object[]) =>
    timelineTurns([
      agentMessage('u1', 'user', 'draw a ship'),
      { id: 'a1', role: 'assistant', parts, metadata: { agentTurn } },
    ])[0]
  const detailsOf = (turn: object) => (turn as { details?: TurnDetails }).details
  const resultOf = (turn: object) => (turn as { result?: TurnResultPart[] }).result
  const summaryTextOf = (turn: { kind: string }) =>
    turnDetailsSummaryText(detailsOf(turn)!.summary, labels)

  it("puts a chat Turn's reasoning and tool calls in Turn Details, its prose and images in the Result", () => {
    const turn = chatTurn([
      reasoning(41000),
      text('here is the ship'),
      chatImageTool('t1', 'ship.png'),
      text('and the rock'),
      chatImageTool('t2', 'rock.png'),
      { ...tool('searchWeb'), type: 'tool-searchWeb' },
    ])

    expect(detailsOf(turn)?.parts).toEqual([
      { kind: 'reasoning', messageId: 'a1', index: 0 },
      { kind: 'generation', messageId: 'a1', index: 2 },
      { kind: 'generation', messageId: 'a1', index: 4 },
      { kind: 'tool', messageId: 'a1', index: 5 },
    ])
    expect(resultOf(turn)).toEqual([
      { kind: 'prose', messageId: 'a1', index: 1 },
      { kind: 'artifact', messageId: 'a1', index: 2 },
      { kind: 'prose', messageId: 'a1', index: 3 },
      { kind: 'artifact', messageId: 'a1', index: 4 },
    ])
  })

  it('gives a chat image and an Agent Preset image the same Result', () => {
    const chat = chatTurn([text('here it is'), chatImageTool('t1', 'ship.png')])
    const agent = agentTurnWith([text('here it is'), agentImageTool('t1', 'ship.png')])

    expect(resultOf(chat)).toEqual(resultOf(agent))
    expect(summaryTextOf(chat)).toBe(summaryTextOf(agent))
  })

  it("puts an agent's compaction notices, tool calls and game workspace path in Turn Details", () => {
    const turn = agentTurnWith([
      { type: 'step-start' },
      reasoning(2000),
      tool('compaction'),
      tool('read'),
      agentImageTool('t1', 'ship.png', 'generated/ship.png'),
      text('done'),
    ])

    expect(detailsOf(turn)?.parts).toEqual([
      { kind: 'reasoning', messageId: 'a1', index: 1 },
      { kind: 'compaction', messageId: 'a1', index: 2 },
      { kind: 'tool', messageId: 'a1', index: 3 },
      { kind: 'generation', messageId: 'a1', index: 4 },
      { kind: 'workspace-path', path: 'generated/ship.png' },
    ])
    expect(resultOf(turn)).toEqual([
      { kind: 'artifact', messageId: 'a1', index: 4 },
      { kind: 'prose', messageId: 'a1', index: 5 },
    ])
  })

  it('sums up a chat Turn by its reasoning time, tools and images', () => {
    const turn = chatTurn([
      reasoning(30000),
      chatImageTool('t1', 'ship.png'),
      reasoning(11000),
      chatImageTool('t2', 'rock.png'),
      text('done'),
    ])

    expect(detailsOf(turn)?.summary).toEqual({
      kind: 'activity',
      reasoningMs: 41000,
      tools: 2,
      artifacts: { image: 2 },
    })
    expect(summaryTextOf(turn)).toBe('Reasoned 41s · 2 tools · 2 images')
  })

  it('leaves out of the summary what a Turn did not do', () => {
    const turn = agentTurnWith([tool('read'), text('done')])

    expect(detailsOf(turn)?.summary).toEqual({ kind: 'activity', tools: 1 })
    expect(summaryTextOf(turn)).toBe('1 tool')
  })

  it('has nothing in Turn Details for a plain chat answer', () => {
    const turn = chatTurn([text('hello')])

    expect(detailsOf(turn)).toEqual({ parts: [], summary: { kind: 'activity' } })
    expect(resultOf(turn)).toEqual([{ kind: 'prose', messageId: 'a1', index: 0 }])
    expect(turnDetailsShown(detailsOf(turn)!)).toBe(false)
  })

  it('shows Turn Details for a Turn whose only content is its summary', () => {
    const [turn] = timelineTurns([
      user('u1', 'Read this'),
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          {
            type: 'data-audio',
            data: { kind: 'tts', preset: 'Text to Speech', status: 'completed', engine: 'Kokoro' },
          },
        ],
      },
    ])

    expect(turnDetailsShown(detailsOf(turn)!)).toBe(true)
    expect(turnDetailsShown(detailsOf(chatTurn([reasoning(2000), text('hi')]))!)).toBe(true)
  })

  it('says a Turn reasoned even when its transcript predates reasoning times', () => {
    const turn = chatTurn([{ type: 'reasoning', text: 'hmm', state: 'done' }, text('hi')])

    expect(summaryTextOf(turn)).toBe('Reasoned')
  })

  it("puts a ComfyUI Turn's variant and workflow parameters in Turn Details, summed up by preset, size, seed and duration", () => {
    const settings = {
      preset: 'Flux Schnell',
      variant: 'Fast',
      prompt: 'a castle',
      seed: 42,
      width: 1024,
      height: 1024,
    }
    const inputs = [
      { label: 'Guidance', nodeTitle: 'g', nodeInput: 'v', type: 'number', current: 3.5 },
    ]
    const [turn] = timelineTurns([
      mediaPrompt,
      {
        ...mediaCard,
        parts: [
          {
            type: 'data-media',
            data: {
              runId: 'r1',
              mode: 'imageGen',
              preset: 'Flux Schnell',
              variant: 'Fast',
              status: 'completed',
              durationMs: 18200,
              items: [image('castle.png', { settings, dynamicSettings: inputs })],
            },
          },
        ],
      },
    ])

    expect(detailsOf(turn)?.parts).toEqual([
      {
        kind: 'workflow',
        variant: 'Fast',
        settings: { seed: 42, width: 1024, height: 1024 },
        inputs,
      },
    ])
    expect(resultOf(turn)).toEqual([{ kind: 'media' }])
    expect(detailsOf(turn)?.summary).toEqual({
      kind: 'workflow',
      preset: 'Flux Schnell',
      width: 1024,
      height: 1024,
      seed: 42,
      durationMs: 18200,
    })
    expect(summaryTextOf(turn)).toBe('Flux Schnell · 1024×1024 · seed 42 · 18s')
  })

  it('keeps the full error of a failed ComfyUI Turn in Turn Details', () => {
    const [turn] = timelineTurns([
      mediaPrompt,
      {
        ...mediaCard,
        parts: [
          {
            type: 'data-media',
            data: {
              runId: 'r1',
              mode: 'video',
              preset: 'Wan',
              status: 'failed',
              error: 'out of memory',
              items: [],
            },
          },
        ],
      },
    ])

    expect(detailsOf(turn)).toEqual({
      parts: [],
      summary: { kind: 'workflow', preset: 'Wan' },
      error: 'out of memory',
    })
    expect(summaryTextOf(turn)).toBe('Wan')
  })

  it('sums up an audio Turn by its preset and engine, with the audio in the Result', () => {
    const [turn] = timelineTurns([
      user('u1', 'Read this'),
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 2,
        parts: [
          {
            type: 'data-audio',
            data: { kind: 'tts', preset: 'Text to Speech', status: 'completed', engine: 'Kokoro' },
          },
        ],
      },
    ])

    expect(resultOf(turn)).toEqual([{ kind: 'audio' }])
    expect(detailsOf(turn)).toEqual({
      parts: [],
      summary: { kind: 'speech', preset: 'Text to Speech', engine: 'Kokoro' },
    })
    expect(summaryTextOf(turn)).toBe('Text to Speech · Kokoro')
  })

  it("shows an agent's speech clip in the Result and its tool call in Turn Details", () => {
    const speak = {
      ...tool('speak'),
      output: { details: { audio: { savedFilePath: '/a/clip.wav', message: 'ok' } } },
    }
    const turn = agentTurnWith([speak])

    expect(detailsOf(turn)?.parts).toEqual([{ kind: 'tool', messageId: 'a1', index: 0 }])
    expect(resultOf(turn)).toEqual([{ kind: 'artifact', messageId: 'a1', index: 0 }])
    expect(summaryTextOf(turn)).toBe('1 tool · 1 audio clip')
  })

  it('gives Turns still running a Turn Details and Result of their own', () => {
    const items = sessionTimelineItems([], {
      media: { runId: 'r2', prompt: 'a dragon', preset: 'Wan', mode: 'video' },
      audio: { kind: 'stt', prompt: '', preset: 'Speech to Text' },
    })

    expect(items).toMatchObject([
      {
        details: { parts: [], summary: { kind: 'workflow', preset: 'Wan' } },
        result: [{ kind: 'media' }],
      },
      {
        details: { parts: [], summary: { kind: 'speech', preset: 'Speech to Text' } },
        result: [{ kind: 'audio' }],
      },
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

describe('artifacts on every Turn', () => {
  const sessionUrl = (name: string) => `aipg-media://sessions/s1/files/${name}`
  const image = (id: string) => ({
    id,
    type: 'image',
    state: 'done',
    mode: 'imageGen',
    imageUrl: sessionUrl(`${id}.png`),
    settings: {},
  })
  const chatTurnWith = (item: object) => [
    chatMessage('u1', 'user', 'draw a castle'),
    {
      id: 'a1',
      role: 'assistant',
      metadata: { chatTurn: true },
      parts: [
        {
          type: 'tool-comfyUI',
          toolCallId: 't1',
          state: 'output-available',
          input: { workflow: 'Draft', prompt: 'a castle' },
          output: { images: [item] },
        },
      ],
    },
  ]
  const agentTurnWith = (item: object) => [
    agentMessage('u2', 'user', 'draw a castle'),
    {
      id: 'a2',
      role: 'assistant',
      metadata: { agentTurn },
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'generateImage',
          toolCallId: 't2',
          state: 'output-available',
          input: { prompt: 'a castle' },
          output: {
            content: [],
            details: { items: [{ ...item, workspacePath: 'generated/a.png' }] },
          },
        },
      ],
    },
  ]
  const mediaTurnWith = (item: object) => [
    mediaPrompt,
    {
      ...mediaCard,
      parts: [{ type: 'data-media', data: { ...mediaCard.parts[0].data, items: [item] } }],
    },
  ]
  const everySurface = (item: object) => [
    chatTurnWith(item),
    agentTurnWith(item),
    mediaTurnWith(item),
  ]
  const artifactsOf = (timeline: unknown[], deletedUrls: string[] = []) =>
    sessionTimelineItems(timeline, {}, { deletedUrls }).flatMap((turn) =>
      'artifacts' in turn ? turn.artifacts : [],
    )

  it("puts the prompt the model wrote into the card's Info, for chat and Agent Preset tools", () => {
    const prompts = [chatTurnWith(image('c1')), agentTurnWith(image('g1'))].map((timeline) =>
      artifactsOf(timeline).map((artifact) => artifact.item.settings?.prompt),
    )

    expect(prompts).toEqual([['a castle'], ['a castle']])
  })

  it("keeps the prompt the media specialist wrote for each of its generations in the card's Info", () => {
    const specialistImage = { ...image('m1'), settings: { prompt: 'a moonlit castle' } }
    const mediaToolTurn = (type: string, output: object) => [
      chatMessage('u1', 'user', 'draw a castle'),
      {
        id: 'a1',
        role: 'assistant',
        metadata: { chatTurn: true },
        parts: [
          {
            type,
            toolName: 'media',
            toolCallId: 't1',
            state: 'output-available',
            input: { request: 'a castle at night' },
            output,
          },
        ],
      },
    ]

    const chat = artifactsOf(mediaToolTurn('tool-media', { images: [specialistImage] }))
    expect(chat.map((artifact) => artifact.item.settings?.prompt)).toEqual(['a moonlit castle'])
  })

  it('offers the same actions on an image a chat tool, an Agent Preset or a ComfyUI preset made', () => {
    for (const timeline of everySurface(image('i1'))) {
      const [artifact] = artifactsOf(timeline)
      expect(artifact).toMatchObject({ mediaType: 'image', state: 'done' })
      expect(artifact.actions).toEqual([
        'info',
        'zoom',
        'copy',
        'download',
        'openFolder',
        'sendToEdit',
        'sendToVideo',
        'delete',
      ])
    }
  })

  it('shows a deleted file as deleted on every kind of Turn, offering only its Info', () => {
    for (const timeline of everySurface(image('gone'))) {
      const [artifact] = artifactsOf(timeline, [sessionUrl('gone.png')])
      expect(artifact).toMatchObject({ state: 'deleted', actions: ['info'] })
    }
  })

  it('offers no Copy and no Send to Edit or Video on a video or 3D model', () => {
    const video = { ...image('v1'), type: 'video', videoUrl: sessionUrl('v1.mp4') }
    const model = { ...image('m1'), type: 'model3d', model3dUrl: sessionUrl('m1.glb') }
    for (const item of [video, model]) {
      for (const timeline of everySurface(item)) {
        expect(artifactsOf(timeline)[0].actions).toEqual([
          'info',
          'zoom',
          'download',
          'openFolder',
          'delete',
        ])
      }
    }
  })

  it('offers Delete only for a file in the Session Folder', () => {
    const outside = { ...image('o1'), imageUrl: 'aipg-media://media/o1.png' }
    for (const timeline of everySurface(outside)) {
      expect(artifactsOf(timeline)[0].actions).not.toContain('delete')
    }
  })
})

describe('the live status line of a running Turn', () => {
  const labels = {
    reasoning: 'Reasoning…',
    writing: 'Writing…',
    working: 'Working…',
    runningTool: 'Running {tool}…',
    queued: 'Waiting for the running turn to finish…',
    audioLoading: 'Loading voice…',
    audioGenerating: 'Generating speech…',
    audioTranscribing: 'Transcribing…',
    artifact: {
      COM_GENERATION_QUEUED: 'Queued',
      COM_STARTING_BACKEND: 'Starting image backend',
      COM_INSTALL_WORKFLOW_COMPONENTS: 'Installing',
      COM_LOADING_WORKFLOW_COMPONENTS: 'Loading components',
      COM_LOADING_MODEL: 'Loading model…',
      COM_GENERATING: 'Generating',
    },
  }
  const detailsOf = (item: object | undefined) => (item as { details: TurnDetails }).details
  const liveTextOf = (item: object | undefined) => {
    const live = detailsOf(item).live
    return live ? turnLiveText(live, labels) : undefined
  }
  const streamingReasoning = { type: 'reasoning', text: 'hmm', state: 'streaming' }
  const runningTool = (name: string, input: object = {}) => ({
    type: 'dynamic-tool',
    toolName: name,
    toolCallId: `call-${name}`,
    state: 'input-available',
    input,
  })
  const chatAnswer = (parts: object[]) => ({
    id: 'a1',
    role: 'assistant',
    parts,
    metadata: { chatTurn: true },
  })
  const agentAnswer = (parts: object[]) => ({
    id: 'a1',
    role: 'assistant',
    parts,
    metadata: { agentTurn },
  })
  const liveAgent = (messages: object[], extra: object = {}) => ({
    tag: agentTurn,
    messages: messages as { id: string }[],
    live: true,
    ...extra,
  })

  it('shows what a chat Turn waits on before its answer exists', () => {
    const items = sessionTimelineItems([], {
      chat: [chatMessage('u1', 'user', 'hi')],
      chatStatus: {
        running: true,
        activity: { label: 'Loading model…', progress: 0.4 },
        questionKey: 'session:s1',
      },
    })

    expect(detailsOf(items[0]).live).toEqual({
      kind: 'activity',
      label: 'Loading model…',
      progress: 0.4,
    })
    expect(liveTextOf(items[0])).toBe('Loading model…')
    expect(items[0]).toMatchObject({ questionKey: 'session:s1' })
  })

  it('says a chat Turn is reasoning while its reasoning streams', () => {
    const items = sessionTimelineItems([], {
      chat: [chatMessage('u1', 'user', 'hi'), chatAnswer([streamingReasoning])],
      chatStatus: { running: true },
    })

    expect(liveTextOf(items[0])).toBe('Reasoning…')
  })

  it('names the tool a chat Turn is running', () => {
    const items = sessionTimelineItems([], {
      chat: [chatMessage('u1', 'user', 'hi'), chatAnswer([runningTool('searchWeb')])],
      chatStatus: { running: true },
    })

    expect(liveTextOf(items[0])).toBe('Running searchWeb…')
  })

  it("prefers the media specialist's current step over the chat activity", () => {
    const items = sessionTimelineItems([], {
      chat: [chatMessage('u1', 'user', 'hi'), chatAnswer([runningTool('media')])],
      chatStatus: { running: true, activity: { label: 'Creating media…' } },
      mediaSteps: { 'call-media': { label: 'Generating 2/8', progress: 0.25 } },
    })

    expect(detailsOf(items[0]).live).toEqual({
      kind: 'tool',
      name: 'media',
      label: 'Generating 2/8',
      progress: 0.25,
    })
  })

  it('switches a chat Turn to its summary once it settles', () => {
    const items = sessionTimelineItems([], {
      chat: [chatMessage('u1', 'user', 'hi'), chatAnswer([{ type: 'text', text: 'hello' }])],
      chatStatus: { running: false, questionKey: 'session:s1' },
    })

    expect(detailsOf(items[0]).live).toBeUndefined()
    expect(items[0]).not.toHaveProperty('questionKey')
  })

  it('shows the live status on the running chat Turn only', () => {
    const items = sessionTimelineItems(
      [chatMessage('u0', 'user', 'old'), chatMessage('a0', 'assistant', 'done')],
      { chat: [chatMessage('u1', 'user', 'hi')], chatStatus: { running: true } },
    )

    expect(detailsOf(items[0]).live).toBeUndefined()
    expect(liveTextOf(items[1])).toBe('Working…')
  })

  it('names the file an Agent Preset Turn is reading', () => {
    const items = sessionTimelineItems([], {
      agents: [
        liveAgent([
          agentMessage('u1', 'user', 'fix it'),
          agentAnswer([runningTool('read', { file_path: 'game.js' })]),
        ]),
      ],
    })

    expect(liveTextOf(items[0])).toBe('Reading game.js…')
  })

  it('says an Agent Preset Turn runs generateImage', () => {
    const items = sessionTimelineItems([], {
      agents: [
        liveAgent([
          agentMessage('u1', 'user', 'draw'),
          agentAnswer([runningTool('generateImage')]),
        ]),
      ],
    })

    expect(liveTextOf(items[0])).toBe('Running generateImage…')
  })

  it('says an Agent Preset Turn is working between tool calls', () => {
    const done = { ...runningTool('bash'), state: 'output-available', output: {} }
    const items = sessionTimelineItems([], {
      agents: [liveAgent([agentMessage('u1', 'user', 'go'), agentAnswer([done])])],
    })

    expect(liveTextOf(items[0])).toBe('Working…')
  })

  it('says a queued Agent Preset Turn waits for the running one', () => {
    const items = sessionTimelineItems([], {
      agents: [liveAgent([agentMessage('u1', 'user', 'go')], { queuedMessageId: 'u1' })],
    })

    expect(detailsOf(items[0]).live).toEqual({ kind: 'queued' })
    expect(liveTextOf(items[0])).toBe('Waiting for the running turn to finish…')
  })

  it("puts an agent's question, held answer and error in its last Turn", () => {
    const items = sessionTimelineItems([], {
      agents: [
        liveAgent(
          [
            agentMessage('u1', 'user', 'one'),
            agentMessage('a1', 'assistant', 'ok'),
            agentMessage('u2', 'user', 'two'),
          ],
          {
            live: false,
            open: true,
            heldAnswer: { channel: 'telegram' },
            error: 'backend died',
          },
        ),
      ],
    })

    expect(items[0]).not.toHaveProperty('heldAnswer')
    expect(detailsOf(items[0]).error).toBeUndefined()
    expect(items[1]).toMatchObject({
      heldAnswer: { channel: 'telegram' },
      questionKey: 'aipg-agent-1',
    })
    expect(detailsOf(items[1]).error).toBe('backend died')
    expect(detailsOf(items[1]).errorLine).toBe('backend died')
    expect(detailsOf(items[1]).live).toBeUndefined()
  })

  it('switches an Agent Preset Turn to its summary once it settles', () => {
    const items = sessionTimelineItems([], {
      agents: [
        liveAgent([agentMessage('u1', 'user', 'go'), agentAnswer([streamingReasoning])], {
          live: false,
        }),
      ],
    })

    expect(detailsOf(items[0]).live).toBeUndefined()
  })

  it('shows the phase of a ComfyUI run in flight', () => {
    const items = sessionTimelineItems([], {
      media: { runId: 'r2', prompt: 'a dragon', preset: 'Wan', mode: 'video' as const },
      artifactRuns: {
        runs: {
          r2: {
            runId: 'r2',
            phase: 'running' as const,
            progress: { current: 3, max: 20 },
            items: [],
            order: 0,
          },
        },
        nextOrder: 1,
      },
    })

    expect(detailsOf(items[0]).live).toEqual({
      kind: 'artifact',
      phase: 'running',
      progress: { current: 3, max: 20 },
    })
    expect(liveTextOf(items[0])).toBe('Generating 3/20')
  })

  it('says a ComfyUI run is queued before its run is known', () => {
    const items = sessionTimelineItems([], {
      media: { runId: 'r2', prompt: 'a dragon', preset: 'Wan', mode: 'video' as const },
    })

    expect(liveTextOf(items[0])).toBe('Queued')
  })

  it('switches a ComfyUI Turn to its summary once it settles', () => {
    const items = sessionTimelineItems([mediaPrompt, mediaCard], {
      media: { runId: 'r1', prompt: 'a castle', preset: 'Draft', mode: 'imageGen' as const },
      artifactRuns: {
        runs: { r1: { runId: 'r1', phase: 'running' as const, items: [], order: 0 } },
        nextOrder: 1,
      },
    })

    expect(items).toHaveLength(1)
    expect(detailsOf(items[0]).live).toBeUndefined()
  })

  it('shows the phase of an audio Turn in flight', () => {
    const items = sessionTimelineItems([], {
      audio: {
        kind: 'tts' as const,
        prompt: 'hi',
        preset: 'Text to Speech',
        phase: 'generating' as const,
      },
    })

    expect(detailsOf(items[0]).live).toEqual({ kind: 'audio', phase: 'generating' })
    expect(liveTextOf(items[0])).toBe('Generating speech…')
  })
})

describe('Regenerate on the last ComfyUI Turn', () => {
  const sourceInput = {
    label: 'Image',
    nodeTitle: 'Load Image',
    nodeInput: 'image',
    type: 'image',
    defaultValue: '',
  }
  const strengthInput = {
    label: 'Strength',
    nodeTitle: 'Sampler',
    nodeInput: 'denoise',
    type: 'number',
    defaultValue: 1,
  }
  const editItem = (image: string, extra: object = {}) => ({
    id: 'i1',
    state: 'done',
    mode: 'imageEdit',
    type: 'image',
    imageUrl: 'aipg-media://sessions/s1/files/out.png',
    settings: {
      preset: 'Edit',
      variant: 'Fast',
      prompt: 'make it blue',
      negativePrompt: 'blurry',
      seed: 42,
      inferenceSteps: 8,
      width: 768,
      height: 512,
      batchSize: 2,
    },
    dynamicSettings: [
      { ...strengthInput, current: 0.6 },
      { ...sourceInput, current: image },
    ],
    ...extra,
  })
  const comfyTurn = (id: string, data: object) => [
    { ...mediaPrompt, id: `p-${id}`, parts: [{ type: 'text', text: 'make it blue' }] },
    {
      ...mediaCard,
      id,
      parts: [
        {
          type: 'data-media',
          data: {
            runId: `r-${id}`,
            mode: 'imageEdit',
            preset: 'Edit',
            variant: 'Fast',
            status: 'completed',
            items: [editItem('aipg-media://sessions/s1/files/in.png')],
            ...data,
          },
        },
      ],
    },
  ]
  const footerOf = (item: unknown) =>
    (item as { footer: { actions: string[]; rerun?: unknown } }).footer

  it("reruns the last ComfyUI Turn's preset, variant, settings and inputs with a new seed", () => {
    const items = sessionTimelineItems(comfyTurn('c1', {}), {})

    expect(footerOf(items[0])).toEqual({
      actions: ['regenerate'],
      text: '',
      rerun: {
        mode: 'imageEdit',
        workflow: 'Edit',
        variant: 'Fast',
        prompt: 'make it blue',
        negativePrompt: 'blurry',
        params: { seed: -1, inferenceSteps: 8, width: 768, height: 512, batchSize: 2 },
        inputs: {
          'Sampler.denoise': 0.6,
          'Load Image.image': 'aipg-media://sessions/s1/files/in.png',
        },
        inputImageUrl: 'aipg-media://sessions/s1/files/in.png',
      },
    })
  })

  it('offers Regenerate on the last ComfyUI Turn only', () => {
    const items = sessionTimelineItems([...comfyTurn('c1', {}), ...comfyTurn('c2', {})], {})

    expect(items.map((item) => footerOf(item).actions)).toEqual([[], ['regenerate']])
  })

  it('offers no Regenerate on a ComfyUI Turn that another Turn followed', () => {
    const items = sessionTimelineItems(
      [
        ...comfyTurn('c1', {}),
        chatMessage('u1', 'user', 'hi'),
        chatMessage('a1', 'assistant', 'yo'),
      ],
      {},
    )

    expect(footerOf(items[0]).actions).toEqual([])
  })

  it('offers no Regenerate while another ComfyUI run is in flight', () => {
    const items = sessionTimelineItems(comfyTurn('c1', {}), {
      media: { runId: 'r9', prompt: 'again', preset: 'Edit', mode: 'imageEdit' as const },
    })

    expect(footerOf(items[0]).actions).toEqual([])
  })

  it('offers Regenerate on a failed run that recorded its settings', () => {
    const items = sessionTimelineItems(
      comfyTurn('c1', {
        status: 'failed',
        error: 'out of memory',
        items: [editItem('aipg-media://sessions/s1/files/in.png', { state: 'failed' })],
      }),
      {},
    )

    expect(footerOf(items[0]).actions).toEqual(['regenerate'])
  })

  it('offers no Regenerate on a run that recorded no settings', () => {
    const items = sessionTimelineItems(comfyTurn('c1', { status: 'failed', items: [] }), {})

    expect(footerOf(items[0]).actions).toEqual([])
  })

  it('reruns with the recorded source image when the Session could not keep the input', () => {
    const items = sessionTimelineItems(
      comfyTurn('c1', {
        items: [editItem('', { sourceImageUrl: 'aipg-media://sessions/s1/files/src.png' })],
      }),
      {},
    )

    expect(footerOf(items[0])).toMatchObject({
      rerun: { inputs: { 'Load Image.image': 'aipg-media://sessions/s1/files/src.png' } },
    })
  })

  it('offers no Regenerate when the input image is lost', () => {
    const items = sessionTimelineItems(comfyTurn('c1', { items: [editItem('')] }), {})

    expect(footerOf(items[0]).actions).toEqual([])
  })

  it('keeps an optional input image left empty', () => {
    const optional = { ...sourceInput, nodeTitle: 'Style', optional: true, current: '' }
    const item = editItem('aipg-media://sessions/s1/files/in.png')
    const items = sessionTimelineItems(
      comfyTurn('c1', {
        items: [{ ...item, dynamicSettings: [...item.dynamicSettings, optional] }],
      }),
      {},
    )

    expect(footerOf(items[0])).toMatchObject({ rerun: { inputs: { 'Style.image': '' } } })
  })
})

describe('a running artifact on every Turn', () => {
  const queued = (id: string, width: number, height: number) => ({
    id,
    type: 'image' as const,
    state: 'queued' as const,
    mode: 'imageGen' as const,
    imageUrl: '',
    settings: { width, height },
  })
  const run = (runId: string, owner: ArtifactRunOwner, items: MediaItem[]): ArtifactRunView => ({
    runId,
    owner,
    phase: 'running',
    progress: { current: 3, max: 8 },
    items,
    order: 0,
  })
  const runningTool = (type: string, toolCallId: string, extra: object = {}) => ({
    type,
    toolCallId,
    state: 'input-available',
    input: { prompt: 'a castle' },
    ...extra,
  })
  const chatTurn = [
    chatMessage('u1', 'user', 'draw a castle'),
    {
      id: 'a1',
      role: 'assistant',
      metadata: { chatTurn: true },
      parts: [runningTool('tool-comfyUI', 't1')],
    },
  ]
  const agentTurnRunning = [
    agentMessage('u2', 'user', 'draw a castle'),
    {
      id: 'a2',
      role: 'assistant',
      metadata: { agentTurn },
      parts: [runningTool('dynamic-tool', 't2', { toolName: 'generateImage' })],
    },
  ]
  const artifactRuns: ArtifactRunsState = {
    nextOrder: 3,
    runs: {
      rc: run('rc', { kind: 'tool', toolCallId: 't1' }, [queued('ci', 1024, 768)]),
      ra: run('ra', { kind: 'tool', toolCallId: 't2' }, [queued('ai', 1024, 768)]),
      rp: run('rp', { kind: 'panel' }, [queued('pi', 1024, 768)]),
    },
  }
  const pending = { runId: 'rp', prompt: 'a castle', preset: 'Draft', mode: 'imageGen' as const }
  const artifactsIn = (items: { kind: string }[]) =>
    items.flatMap((turn) => ('artifacts' in turn ? (turn.artifacts as TurnArtifact[]) : []))

  it('carries its requested size, phase and progress on chat, Agent Preset and ComfyUI Turns', () => {
    const surfaces: [unknown[], typeof pending | null][] = [
      [chatTurn, null],
      [agentTurnRunning, null],
      [[], pending],
    ]
    for (const [timeline, media] of surfaces) {
      const [artifact] = artifactsIn(sessionTimelineItems(timeline, { media, artifactRuns }))
      expect(artifact).toMatchObject({
        state: 'running',
        size: { width: 1024, height: 768 },
        phase: 'running',
        progress: { current: 3, max: 8 },
        actions: [],
      })
    }
  })

  it('shows a waiting item of a batch as queued while its sibling generates', () => {
    const batch: ArtifactRunsState = {
      nextOrder: 1,
      runs: {
        rp: run('rp', { kind: 'panel' }, [
          { ...queued('p1', 512, 512), state: 'generating' },
          queued('p2', 512, 512),
        ]),
      },
    }
    const artifacts = artifactsIn(sessionTimelineItems([], { media: pending, artifactRuns: batch }))
    expect(artifacts.map((artifact) => [artifact.phase, artifact.progress])).toEqual([
      ['running', { current: 3, max: 8 }],
      ['queued', undefined],
    ])
  })

  it('reserves the requested size of a ComfyUI run before the runner has started it', () => {
    const media = {
      ...pending,
      runId: 'not-yet',
      size: { width: 832, height: 1216 },
      batchSize: 2,
    }
    const artifacts = artifactsIn(sessionTimelineItems([], { media, artifactRuns }))
    expect(artifacts).toHaveLength(2)
    for (const artifact of artifacts) {
      expect(artifact).toMatchObject({
        state: 'running',
        size: { width: 832, height: 1216 },
        phase: 'queued',
      })
    }
  })

  it('keeps the requested size once the artifact is done, so it takes the same box', () => {
    const done = {
      ...queued('d1', 1024, 768),
      state: 'done',
      imageUrl: 'aipg-media://sessions/s1/files/d1.png',
    }
    const card = {
      ...mediaCard,
      parts: [{ type: 'data-media', data: { ...mediaCard.parts[0].data, items: [done] } }],
    }
    const [artifact] = artifactsIn(sessionTimelineItems([mediaPrompt, card], {}))
    expect(artifact).toMatchObject({ state: 'done', size: { width: 1024, height: 768 } })
    expect(artifact).not.toHaveProperty('phase')
  })
})

describe('failed and cancelled artifacts on every Turn', () => {
  const slot = (id: string, state: 'failed' | 'stopped') => ({
    id,
    type: 'image',
    state,
    mode: 'imageGen',
    imageUrl: '',
    settings: { width: 1024, height: 768 },
  })
  const fullError = 'CUDA out of memory\nTried to allocate 2 GiB'
  const chatToolTurn = (output: object, toolState = 'output-available') => [
    chatMessage('u1', 'user', 'draw a castle'),
    {
      id: 'a1',
      role: 'assistant',
      metadata: { chatTurn: true },
      parts: [
        {
          type: 'tool-comfyUI',
          toolCallId: 't1',
          state: toolState,
          input: { workflow: 'Draft', prompt: 'a castle' },
          output,
        },
      ],
    },
  ]
  const agentToolTurn = (output: object, toolState = 'output-available', extra: object = {}) => [
    agentMessage('u2', 'user', 'draw a castle'),
    {
      id: 'a2',
      role: 'assistant',
      metadata: { agentTurn },
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'generateImage',
          toolCallId: 't2',
          state: toolState,
          input: { prompt: 'a castle' },
          output,
          ...extra,
        },
      ],
    },
  ]
  const mediaTurn = (status: 'failed' | 'cancelled', items: object[], error?: string) => [
    mediaPrompt,
    {
      ...mediaCard,
      parts: [
        {
          type: 'data-media',
          data: { ...mediaCard.parts[0].data, status, ...(error ? { error } : {}), items },
        },
      ],
    },
  ]
  const chatFailure = (state: 'failed' | 'cancelled', unfinished: object[]) => ({
    success: false,
    state,
    message:
      state === 'cancelled' ? 'Generation cancelled.' : `ComfyUI generation failed: ${fullError}`,
    ...(state === 'failed' ? { error: fullError } : {}),
    images: [],
    unfinished,
  })
  const agentFailure = (state: 'failed' | 'cancelled', items: object[]) => ({
    content: [{ type: 'text', text: '{"success":false}' }],
    details: { items, failure: { state, ...(state === 'failed' ? { error: fullError } : {}) } },
  })
  const turnOf = (items: unknown[]) => items[0] as SessionTimelineItem
  const itemsOf = (timeline: unknown[], live = {}) => sessionTimelineItems(timeline, live)
  const artifactsOf = (item: SessionTimelineItem) =>
    'artifacts' in item ? (item.artifacts as TurnArtifact[]) : []
  const resultOf = (item: SessionTimelineItem) => ('result' in item ? item.result : [])
  const errorOf = (item: SessionTimelineItem) => ('details' in item ? item.details.error : '')

  it('settles a failed generation into a card of its size with a one-line reason', () => {
    const surfaces = [
      chatToolTurn(chatFailure('failed', [slot('f1', 'failed')])),
      agentToolTurn(agentFailure('failed', [slot('f1', 'failed')])),
      mediaTurn('failed', [slot('f1', 'failed')], fullError),
    ]
    for (const timeline of surfaces) {
      const turn = turnOf(itemsOf(timeline))
      expect(artifactsOf(turn)).toEqual([
        expect.objectContaining({
          state: 'failed',
          size: { width: 1024, height: 768 },
          reason: 'CUDA out of memory',
          actions: ['info'],
        }),
      ])
      expect(errorOf(turn)).toBe(fullError)
      expect(resultOf(turn).some((part) => part.kind === 'failure')).toBe(false)
    }
  })

  it('settles a cancelled generation into a card of its size saying it was cancelled', () => {
    const surfaces = [
      chatToolTurn(chatFailure('cancelled', [slot('s1', 'stopped')])),
      agentToolTurn(agentFailure('cancelled', [slot('s1', 'stopped')])),
      mediaTurn('cancelled', [slot('s1', 'stopped')], 'Generation cancelled.'),
    ]
    for (const timeline of surfaces) {
      const turn = turnOf(itemsOf(timeline))
      const [artifact] = artifactsOf(turn)
      expect(artifact).toMatchObject({ state: 'cancelled', size: { width: 1024, height: 768 } })
      expect(artifact).not.toHaveProperty('reason')
      expect(errorOf(turn)).toBeFalsy()
      expect(resultOf(turn).some((part) => part.kind === 'failure')).toBe(false)
    }
  })

  it('keeps the finished items of a batch beside the one that failed', () => {
    const done = {
      ...slot('d1', 'failed'),
      state: 'done',
      imageUrl: 'aipg-media://sessions/s1/files/d1.png',
    }
    const turn = turnOf(itemsOf(mediaTurn('failed', [done, slot('f2', 'failed')], fullError)))
    expect(artifactsOf(turn).map((artifact) => artifact.state)).toEqual(['done', 'failed'])
  })

  it('fails the placeholder of a run that failed while generating, on every surface', () => {
    const failedRun = (runId: string, owner: ArtifactRunOwner): ArtifactRunView => ({
      runId,
      owner,
      phase: 'failed',
      error: fullError,
      started: true,
      items: [slot(`${runId}-1`, 'failed') as MediaItem],
      order: 0,
    })
    const artifactRuns: ArtifactRunsState = {
      nextOrder: 3,
      runs: {
        rc: failedRun('rc', { kind: 'tool', toolCallId: 't1' }),
        ra: failedRun('ra', { kind: 'tool', toolCallId: 't2' }),
        rp: failedRun('rp', { kind: 'panel' }),
      },
    }
    const pending = { runId: 'rp', prompt: 'a castle', preset: 'Draft', mode: 'imageGen' as const }
    const surfaces: [unknown[], typeof pending | null][] = [
      [chatToolTurn({}, 'input-available'), null],
      [agentToolTurn({}, 'input-available'), null],
      [[], pending],
    ]
    for (const [timeline, media] of surfaces) {
      const [artifact] = artifactsOf(turnOf(itemsOf(timeline, { media, artifactRuns })))
      expect(artifact).toMatchObject({
        state: 'failed',
        size: { width: 1024, height: 768 },
        reason: 'CUDA out of memory',
      })
    }
  })

  it('says in one line why a Turn failed before it generated anything', () => {
    const backendError = 'ComfyUI did not start\nexit code 1'
    const chat = turnOf(
      itemsOf(
        chatToolTurn({
          success: false,
          state: 'failed',
          message: `ComfyUI generation failed: ${backendError}`,
          error: backendError,
          images: [],
        }),
      ),
    )
    const agent = turnOf(
      itemsOf(
        agentToolTurn({
          content: [],
          details: { failure: { state: 'failed', error: backendError } },
        }),
      ),
    )
    const media = turnOf(itemsOf(mediaTurn('failed', [], backendError)))
    for (const turn of [chat, agent, media]) {
      expect(artifactsOf(turn)).toEqual([])
      expect(resultOf(turn).filter((part) => part.kind === 'failure')).toEqual([
        expect.objectContaining({ state: 'failed', reason: 'ComfyUI did not start' }),
      ])
      expect(errorOf(turn)).toBe(backendError)
    }
  })

  it("keeps a failed generation's error out of the line under the header, which its Result says", () => {
    const timeline = agentToolTurn({
      content: [],
      details: { failure: { state: 'failed', error: 'ComfyUI did not start' } },
    })
    const alone = turnOf(itemsOf(timeline))
    const withRunError = turnOf(
      itemsOf(timeline, {
        agents: [{ tag: agentTurn, messages: [], live: false, error: 'backend died' }],
      }),
    )
    expect('details' in alone && alone.details.errorLine).toBeFalsy()
    expect('details' in withRunError && withRunError.details).toMatchObject({
      error: 'ComfyUI did not start\n\nbackend died',
      errorLine: 'backend died',
    })
  })

  it('says a media tool failed when it threw instead of answering', () => {
    const turn = turnOf(
      itemsOf(agentToolTurn({}, 'output-error', { errorText: 'Download declined' })),
    )
    expect(resultOf(turn)).toEqual([
      { kind: 'failure', messageId: 'a2', index: 0, state: 'failed', reason: 'Download declined' },
    ])
    expect(errorOf(turn)).toBe('Download declined')
  })

  it('reads the failure of a media tool saved before failures were recorded', () => {
    const agent = turnOf(
      itemsOf(
        agentToolTurn({
          content: [
            {
              type: 'text',
              text: '{"success":false,"message":"Generation cancelled.","images":[]}',
            },
          ],
        }),
      ),
    )
    const chat = turnOf(
      itemsOf(
        chatToolTurn({ success: false, message: 'ComfyUI generation failed: boom', images: [] }),
      ),
    )
    expect(resultOf(agent)).toEqual([
      { kind: 'failure', messageId: 'a2', index: 0, state: 'cancelled' },
    ])
    expect(resultOf(chat)).toEqual([
      {
        kind: 'failure',
        messageId: 'a1',
        index: 0,
        state: 'failed',
        reason: 'ComfyUI generation failed: boom',
      },
    ])
  })

  it('says a ComfyUI Turn was cancelled before it generated anything', () => {
    const turn = turnOf(itemsOf(mediaTurn('cancelled', [], 'Generation cancelled.')))
    expect(resultOf(turn)).toEqual([{ kind: 'media' }, { kind: 'failure', state: 'cancelled' }])
    expect(errorOf(turn)).toBeFalsy()
  })

  it('says why a ComfyUI run in flight failed before it generated anything', () => {
    const artifactRuns: ArtifactRunsState = {
      nextOrder: 1,
      runs: {
        rp: {
          runId: 'rp',
          owner: { kind: 'panel' },
          phase: 'failed',
          error: 'Download declined',
          items: [slot('p1', 'failed') as MediaItem],
          order: 0,
        },
      },
    }
    const media = { runId: 'rp', prompt: 'a castle', preset: 'Draft', mode: 'imageGen' as const }
    const turn = turnOf(itemsOf([], { media, artifactRuns }))
    expect(artifactsOf(turn)).toEqual([])
    expect('details' in turn && turn.details.live).toBeUndefined()
    expect(errorOf(turn)).toBe('Download declined')
    expect(resultOf(turn)).toEqual([
      { kind: 'media' },
      { kind: 'failure', state: 'failed', reason: 'Download declined' },
    ])
  })
})

describe('one audio card', () => {
  const clipUrl = 'aipg-media://sessions/s1/files/clip.wav'
  const ttsTurn = (audio: object) => [
    user('u1', 'Read this'),
    {
      id: 'a1',
      role: 'assistant',
      createdAt: 2,
      parts: [
        {
          type: 'data-audio',
          data: { kind: 'tts', preset: 'Text to Speech', status: 'completed', ...audio },
        },
      ],
    },
  ]
  const audioArtifactsOf = (items: unknown[]) =>
    items.flatMap((item) =>
      item && typeof item === 'object' && 'audioArtifacts' in item
        ? (item.audioArtifacts as AudioArtifact[])
        : [],
    )
  const audioIn = (timeline: unknown[], deletedUrls: string[] = []) =>
    audioArtifactsOf(sessionTimelineItems(timeline, {}, { deletedUrls }))

  it('offers Download, Open folder and Delete on a Text-to-Speech clip in the Session Folder', () => {
    expect(audioIn(ttsTurn({ audioUrl: clipUrl }))).toEqual([
      {
        id: 'a1',
        mediaType: 'audio',
        state: 'done',
        url: clipUrl,
        actions: ['download', 'openFolder', 'delete'],
      },
    ])
  })

  const chatTts = (state: string, output?: object, extra: object = {}) => [
    chatMessage('u2', 'user', 'say hi'),
    {
      id: 'a2',
      role: 'assistant',
      metadata: { chatTurn: true },
      parts: [
        {
          type: 'tool-synthesizeTextToSpeech',
          toolCallId: 't1',
          state,
          input: { text: 'hi' },
          ...(output ? { output } : {}),
          ...extra,
        },
      ],
    },
  ]
  const agentTts = (audio: object) => [
    agentMessage('u3', 'user', 'say hi'),
    {
      id: 'a3',
      role: 'assistant',
      metadata: { agentTurn },
      parts: [
        {
          type: 'dynamic-tool',
          toolName: 'synthesizeTextToSpeech',
          toolCallId: 't2',
          state: 'output-available',
          input: { text: 'hi' },
          output: { content: [], details: { audio } },
        },
      ],
    },
  ]
  const withoutId = ({ id: _id, ...rest }: AudioArtifact) => rest

  it('shows the same card for an audio Turn and a chat or agent Text-to-Speech result', () => {
    const fromTurn = audioIn(ttsTurn({ audioUrl: clipUrl })).map(withoutId)
    const fromChat = audioIn(
      chatTts('output-available', {
        ok: true,
        message: 'Synthesized speech.',
        savedFilePath: '/audio/clip.wav',
        audioUrl: clipUrl,
      }),
    ).map(withoutId)
    const fromAgent = audioIn(
      agentTts({
        savedFilePath: '/audio/clip.wav',
        workspacePath: 'generated/clip.wav',
        url: clipUrl,
      }),
    ).map(withoutId)

    expect(fromChat).toEqual(fromTurn)
    expect(fromAgent).toEqual(fromTurn)
  })

  it('shows a Text-to-Speech tool call running, failed or erroring in the same card states', () => {
    expect(audioIn(chatTts('input-available'))).toEqual([
      { id: 't1', mediaType: 'audio', state: 'running', phase: 'running', actions: [] },
    ])
    expect(audioIn(chatTts('output-available', { ok: false, message: 'No voice' }))).toEqual([
      { id: 't1', mediaType: 'audio', state: 'failed', reason: 'No voice', actions: [] },
    ])
    expect(
      audioIn(chatTts('output-error', undefined, { errorText: 'engine crashed' })),
    ).toMatchObject([{ state: 'failed', reason: 'engine crashed' }])
  })

  it("puts an agent's Text-to-Speech call in the Result while it runs", () => {
    const [, answer] = agentTts({})
    const running = {
      ...answer,
      parts: [{ ...answer.parts[0], state: 'input-available', output: undefined }],
    }
    const [turn] = sessionTimelineItems([agentMessage('u3', 'user', 'say hi'), running], {})
    expect(turn).toMatchObject({
      result: [{ kind: 'artifact', messageId: 'a3', index: 0 }],
      audioArtifacts: [{ state: 'running', phase: 'running' }],
    })
  })

  it('keeps Download and Open folder on an older clip saved outside the Session Folder', () => {
    expect(
      audioIn(chatTts('output-available', { ok: true, savedFilePath: '/audio/old.wav' })),
    ).toEqual([
      {
        id: 't1',
        mediaType: 'audio',
        state: 'done',
        filePath: '/audio/old.wav',
        actions: ['download', 'openFolder'],
      },
    ])
  })

  it('plays an older chat clip that only kept its audio inline, with no file to act on', () => {
    const dataUri = 'data:audio/wav;base64,UklGRg=='
    expect(
      audioIn(chatTts('output-available', { ok: true, message: 'Done.', audioDataUri: dataUri })),
    ).toEqual([{ id: 't1', mediaType: 'audio', state: 'done', url: dataUri, actions: [] }])
  })

  it('shows a deleted clip as deleted, with nothing left to do with it', () => {
    expect(audioIn(ttsTurn({ audioUrl: clipUrl }), [clipUrl])).toMatchObject([
      { state: 'deleted', url: clipUrl, actions: [] },
    ])
  })

  it('settles a failed or cancelled Text-to-Speech Turn into a card with its reason', () => {
    expect(audioIn(ttsTurn({ status: 'failed', error: 'voice not found' }))).toEqual([
      { id: 'a1', mediaType: 'audio', state: 'failed', reason: 'voice not found', actions: [] },
    ])
    expect(audioIn(ttsTurn({ status: 'cancelled' }))).toEqual([
      { id: 'a1', mediaType: 'audio', state: 'cancelled', actions: [] },
    ])
  })

  it('shows a Text-to-Speech clip still being made with the shared in-card progress', () => {
    const running = (phase: 'loading-model' | 'generating') =>
      audioArtifactsOf(
        sessionTimelineItems([], {
          audio: { kind: 'tts', prompt: 'hi', preset: 'Text to Speech', phase },
        }),
      )
    expect(running('loading-model')).toEqual([
      {
        id: 'pending-audio',
        mediaType: 'audio',
        state: 'running',
        phase: 'loading-model',
        actions: [],
      },
    ])
    expect(running('generating')).toMatchObject([{ state: 'running', phase: 'running' }])
  })

  it('gives a speech-to-text Turn its source audio in the bubble and its transcript as the Result', () => {
    const stt = {
      kind: 'stt',
      preset: 'Speech to Text',
      status: 'completed',
      audioUrl: clipUrl,
      transcript: 'hello there',
    }
    const [turn] = sessionTimelineItems(
      [
        user('u1', ''),
        { id: 'a1', role: 'assistant', createdAt: 2, parts: [{ type: 'data-audio', data: stt }] },
      ],
      {},
    )
    expect(turn).toMatchObject({
      prompt: { audio: [{ url: clipUrl }] },
      result: [{ kind: 'audio' }],
      audioArtifacts: [],
      footer: { actions: ['copy'], text: 'hello there' },
    })
  })
})

describe('the grid a Result lays its artifacts out in', () => {
  const sized = (width: number, height: number) => ({ size: { width, height } })

  it('lays a batch of 4 out side by side when the width fits them', () => {
    expect(artifactGrid(Array(4).fill(sized(1024, 1024)), 1600).columns).toBe(4)
  })

  it('balances a batch that does not fit one row instead of leaving one alone', () => {
    expect(artifactGrid(Array(4).fill(sized(1024, 1024)), 900).columns).toBe(2)
    expect(artifactGrid(Array(5).fill(sized(1024, 1024)), 1100).columns).toBe(3)
  })

  it('stacks the batch in a narrow window', () => {
    expect(artifactGrid(Array(4).fill(sized(1024, 1024)), 360).columns).toBe(1)
  })

  it('never makes more columns than there are artifacts', () => {
    expect(artifactGrid([sized(512, 512)], 2400).columns).toBe(1)
    expect(artifactGrid([], 2400).columns).toBe(1)
  })

  it('caps the grid at the width the artifacts asked for, so it never upscales them', () => {
    expect(artifactGrid(Array(2).fill(sized(512, 512)), 2400).maxWidth).toBe(2 * 512 + 12)
    expect(artifactGrid([sized(512, 512), sized(768, 512)], 2400).maxWidth).toBe(2 * 768 + 12)
  })

  it('leaves the grid uncapped when an artifact has no requested size', () => {
    expect(artifactGrid([sized(512, 512), {}], 2400).maxWidth).toBeUndefined()
  })
})

describe('the box an artifact card takes', () => {
  it('reserves the requested size while the media is not loaded yet', () => {
    expect(artifactFrameSize({ width: 1024, height: 768 }, undefined)).toEqual({
      width: 1024,
      height: 768,
    })
  })

  it('never upscales a result smaller than what was asked for, and keeps its own aspect', () => {
    expect(artifactFrameSize({ width: 1024, height: 1024 }, { width: 512, height: 256 })).toEqual({
      width: 512,
      height: 256,
    })
  })

  it('caps at the requested width when the media is larger, in the media aspect', () => {
    expect(artifactFrameSize({ width: 512, height: 512 }, { width: 1024, height: 768 })).toEqual({
      width: 512,
      height: 384,
    })
  })

  it('takes the natural size when nothing was requested', () => {
    expect(artifactFrameSize(undefined, { width: 300, height: 200 })).toEqual({
      width: 300,
      height: 200,
    })
    expect(artifactFrameSize(undefined, undefined)).toBeUndefined()
  })
})
