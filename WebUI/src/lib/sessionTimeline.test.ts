import { describe, expect, it } from 'vitest'
import { sessionTimelineItems } from './sessionTimeline'

type Items = ReturnType<typeof sessionTimelineItems>

/** The actions a hidden trailing turn must not move onto the turn before it. */
const DESTRUCTIVE = ['regenerate', 'edit', 'delete'] as const

function actionsOf(items: Items, kind: string, at: number): string[] {
  const turn = items.filter((item) => item.kind === kind)[at]
  expect(turn, `expected a ${kind} turn at ${at}`).toBeTruthy()
  return (turn as { footer: { actions: string[] } }).footer.actions
}

function agentRows(
  harness: string,
  promptId: string,
  answerId: string,
  text: string,
  turnId: string,
): unknown[] {
  const tag = { agentTurn: { presetName: 'Assistant', harnessSessionId: harness } }
  return [
    {
      id: promptId,
      role: 'user',
      createdAt: 1,
      parts: [{ type: 'text', text }],
      metadata: tag,
    },
    {
      id: answerId,
      role: 'assistant',
      createdAt: 2,
      parts: [{ type: 'text', text: `answer ${text}` }],
      metadata: { ...tag, harnessTurnId: turnId },
    },
  ]
}

function chatRows(promptId: string, answerId: string, text: string, answerText: string): unknown[] {
  return [
    {
      id: promptId,
      role: 'user',
      createdAt: 1,
      parts: [{ type: 'text', text }],
      metadata: { chatTurn: true },
    },
    {
      id: answerId,
      role: 'assistant',
      createdAt: 2,
      ...(answerText ? { parts: [{ type: 'text', text: answerText }] } : { parts: [] }),
      metadata: { chatTurn: true },
    },
  ]
}

function mediaRows(promptId: string, answerId: string, text: string): unknown[] {
  return [
    {
      id: promptId,
      role: 'user',
      createdAt: 1,
      parts: [{ type: 'text', text }],
    },
    {
      id: answerId,
      role: 'assistant',
      createdAt: 2,
      parts: [
        {
          type: 'data-media',
          data: {
            runId: 'run-1',
            mode: 'imageGen',
            preset: 'Flux',
            status: 'completed',
            items: [
              {
                type: 'image',
                id: 'image-1',
                state: 'done',
                mode: 'imageGen',
                imageUrl: 'aipg-media://image-1.png',
                settings: { prompt: text, seed: 1 },
              },
            ],
          },
        },
      ],
    },
  ]
}

describe('sessionTimelineItems destructive actions at the visible end', () => {
  it('offers regenerate, edit and delete on the last agent turn', () => {
    const rows = [
      ...agentRows('h1', 'u1', 'a1', 'first question', 't1'),
      ...agentRows('h1', 'u2', 'a2', 'second question', 't2'),
    ]
    const actions = actionsOf(sessionTimelineItems(rows, {}), 'agent', 1)
    for (const action of DESTRUCTIVE) expect(actions).toContain(action)
  })

  it('strips regenerate, edit and delete from agent turns that are not the last one', () => {
    const rows = [
      ...agentRows('h1', 'u1', 'a1', 'first question', 't1'),
      ...agentRows('h1', 'u2', 'a2', 'second question', 't2'),
    ]
    const actions = actionsOf(sessionTimelineItems(rows, {}), 'agent', 0)
    for (const action of DESTRUCTIVE) expect(actions).not.toContain(action)
  })

  it('withholds the actions from the last visible agent turn when a hidden turn trails it', () => {
    // Hiding took the trailing turn out of what the view passes; the file's end lies further on.
    const rows = agentRows('h1', 'u1', 'a1', 'first question', 't1')
    const actions = actionsOf(sessionTimelineItems(rows, {}, {}, false), 'agent', 0)
    for (const action of DESTRUCTIVE) expect(actions).not.toContain(action)
    expect(actions).toContain('copy')
    expect(actions).toContain('hide')
  })

  it('offers regenerate, edit and delete on the last chat turn', () => {
    const rows = chatRows('u1', 'a1', 'first question', 'answer first question')
    const actions = actionsOf(sessionTimelineItems(rows, {}), 'chat', 0)
    for (const action of DESTRUCTIVE) expect(actions).toContain(action)
  })

  it('withholds the actions from the last visible chat turn when a hidden turn trails it', () => {
    const rows = chatRows('u1', 'a1', 'first question', 'answer first question')
    const actions = actionsOf(sessionTimelineItems(rows, {}, {}, false), 'chat', 0)
    for (const action of DESTRUCTIVE) expect(actions).not.toContain(action)
    expect(actions).toContain('copy')
    expect(actions).toContain('hide')
  })

  it('still deletes a failed empty chat answer at the true end, but not before a hidden tail', () => {
    const rows = chatRows('u1', 'a1', 'first question', '')

    const atTrueEnd = actionsOf(sessionTimelineItems(rows, {}), 'chat', 0)
    expect(atTrueEnd).toContain('delete')

    const beforeHiddenTail = actionsOf(sessionTimelineItems(rows, {}, {}, false), 'chat', 0)
    expect(beforeHiddenTail).not.toContain('delete')
  })

  it('offers regenerate, edit and delete on the last media turn', () => {
    const rows = mediaRows('u1', 'a1', 'a castle')
    const actions = actionsOf(sessionTimelineItems(rows, {}), 'media', 0)
    for (const action of DESTRUCTIVE) expect(actions).toContain(action)
  })

  it('withholds the actions from the last visible media turn when a hidden turn trails it', () => {
    const rows = mediaRows('u1', 'a1', 'a castle')
    const actions = actionsOf(sessionTimelineItems(rows, {}, {}, false), 'media', 0)
    for (const action of DESTRUCTIVE) expect(actions).not.toContain(action)
    expect(actions).toContain('hide')
  })
})
