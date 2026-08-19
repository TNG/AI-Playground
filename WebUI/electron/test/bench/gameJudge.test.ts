import { describe, expect, it, vi } from 'vitest'
import type { ProbeReport } from '../../agentMode/previewProbe.ts'
import {
  applyGate,
  buildJudgeMessages,
  clipForPrompt,
  probeGate,
  renderReport,
  ScorecardSchema,
  selectSourceFiles,
  type Scorecard,
} from '../../../scripts/bench/gameJudge/rubric.ts'
import { buildRequestBody, extractJson, judgeGame } from '../../../scripts/bench/gameJudge/judge.ts'
import { derivePlayKeys, planPlay } from '../../../scripts/bench/gameJudge/collect.ts'

// The judge grades games with a cloud model and a recording, so almost none of
// it can be asserted without a browser and an API key. What CAN be pinned is the
// part that decides what the score is allowed to be: the gate that stops a model
// calling a blank page a working game, the prompt the model is given, and the
// parsing of what it says back. Those are the failures that would silently
// produce plausible-looking numbers.

const HEALTHY: ProbeReport = {
  installed: true,
  title: 'Space Dodger',
  frames: 31,
  seconds: 0.5,
  canvas: { count: 1, width: 800, height: 600, ink: 0.12 },
  listeners: ['keydown', 'keyup', 'pointerdown', 'resize'],
  keys: [{ key: 'ArrowLeft', delta: 0.031 }],
  game: { state: 'playing', score: 42, entities: 7 },
  errors: [],
  errorCount: 0,
}

const GOOD_CARD: Scorecard = {
  works: { score: 4, evidence: 'The ship dodges rocks and the run ends on a hit.' },
  brief: { score: 4, evidence: 'Rocks fall, arrows steer, the score climbs, game over shows.' },
  looks: { score: 3, evidence: 'Consistent palette and a readable HUD.' },
  bugs: { score: 4, evidence: 'Nothing went wrong in the clip.' },
  overall: 8,
  missingFromBrief: [],
  bugsSeen: [],
  summary: 'A complete little dodger that does what was asked.',
}

describe('probeGate', () => {
  it('lets a working game be scored on its merits', () => {
    expect(probeGate(HEALTHY, HEALTHY)).toEqual({ worksCap: 4, overallCap: 10, reasons: [] })
  })

  // The whole reason the gate exists: a model shown a clip of a black rectangle
  // will describe a game anyway, and its score must not survive that.
  it('caps a page that never animated, whatever the judge said', () => {
    const dead = { ...HEALTHY, frames: 0 }
    const gate = probeGate(dead, dead)

    expect(gate.worksCap).toBe(1)
    expect(applyGate(GOOD_CARD, gate)).toMatchObject({ works: { score: 1 }, overall: 2 })
  })

  it('caps a page that threw, and says what it threw', () => {
    const throwing = { ...HEALTHY, errors: ['TypeError: ship is undefined'], errorCount: 1 }
    const gate = probeGate(throwing, throwing)

    expect(gate.worksCap).toBe(1)
    expect(gate.reasons[0]).toContain('TypeError: ship is undefined')
    expect(applyGate(GOOD_CARD, gate).overall).toBe(2)
  })

  // The probe reports errors with their stack, and a reason spanning ten lines
  // stops being a bullet in the report.
  it('quotes the message without dragging the stack into the report', () => {
    const gate = probeGate(HEALTHY, {
      ...HEALTHY,
      errors: ['TypeError: x is null\n  at frame (game.js:12)\n  at raf'],
      errorCount: 1,
    })

    expect(gate.reasons[0]).toContain('TypeError: x is null')
    expect(gate.reasons[0]).not.toContain('game.js:12')
  })

  // A page that throws on the first frame also never animates and never draws.
  // Reporting the exception rather than the stillness is the difference between
  // a fixable finding and a symptom.
  it('blames the exception, not the frozen loop it caused', () => {
    const broken = {
      ...HEALTHY,
      frames: 0,
      canvas: { count: 1, width: 800, height: 600, ink: 0 },
      errors: ['ReferenceError: ship is not defined'],
      errorCount: 1,
    }

    expect(probeGate(broken, broken).reasons[0]).toContain('ReferenceError')
  })

  // The probe can prove a page is broken; it cannot prove there is no game.
  // Leaving the bottom of the scale to the judge is what keeps a static puzzle
  // from being scored as rubble.
  it('never caps below 1, leaving 0 to the judge', () => {
    const dead = {
      ...HEALTHY,
      frames: 0,
      canvas: { count: 1, width: 800, height: 600, ink: 0 },
      listeners: [],
      errors: ['boom'],
      errorCount: 3,
    }

    expect(probeGate(dead, dead).worksCap).toBe(1)
    expect(
      applyGate(
        { ...GOOD_CARD, works: { score: 0, evidence: 'nothing' }, overall: 0 },
        probeGate(dead, dead),
      ),
    ).toMatchObject({
      works: { score: 0 },
      overall: 0,
    })
  })

  it('caps a canvas that stayed blank', () => {
    const blank = { ...HEALTHY, canvas: { count: 1, width: 800, height: 600, ink: 0 } }

    expect(probeGate(blank, blank).worksCap).toBe(1)
  })

  it('caps a page nothing can be played on', () => {
    const deaf = { ...HEALTHY, listeners: ['resize'] }

    expect(probeGate(deaf, deaf).worksCap).toBe(2)
  })

  // A game that stops its loop on the game-over screen is finished, not frozen,
  // and the second probe alone cannot tell those apart.
  it('does not punish a game whose loop stopped after it ended', () => {
    const ended = { ...HEALTHY, frames: 0, game: { state: 'gameover', score: 120 } }

    expect(probeGate(HEALTHY, ended)).toMatchObject({ worksCap: 4 })
  })

  // WebGL pixels read back as null, and a game is not blank because the probe
  // could not look at it.
  it('does not call an unreadable canvas blank', () => {
    const webgl = { ...HEALTHY, canvas: { count: 1, width: 800, height: 600, ink: null } }

    expect(probeGate(webgl, webgl).worksCap).toBe(4)
  })

  it('reports rather than caps when the probe never installed', () => {
    const gate = probeGate({ installed: false }, { installed: false })

    expect(gate.worksCap).toBe(4)
    expect(gate.reasons[0]).toContain('never installed')
  })

  it('leaves an ungated scorecard exactly as the judge wrote it', () => {
    expect(applyGate(GOOD_CARD, probeGate(HEALTHY, HEALTHY))).toBe(GOOD_CARD)
  })

  it('only ever lowers a score', () => {
    const weak: Scorecard = { ...GOOD_CARD, works: { score: 0, evidence: 'blank' }, overall: 1 }

    expect(applyGate(weak, probeGate({ ...HEALTHY, listeners: [] }, HEALTHY))).toMatchObject({
      works: { score: 0 },
      overall: 1,
    })
  })
})

describe('ScorecardSchema', () => {
  it('accepts a well-formed scorecard', () => {
    expect(ScorecardSchema.parse(GOOD_CARD)).toMatchObject({ overall: 8 })
  })

  it('fills in the lists a model tends to leave out when there is nothing to report', () => {
    const parsed = ScorecardSchema.parse({
      works: { score: 3, evidence: 'plays' },
      brief: { score: 3, evidence: 'mostly' },
      looks: { score: 2, evidence: 'plain' },
      bugs: { score: 3, evidence: 'a glitch' },
      overall: 6,
      summary: 'Fine.',
    })

    expect(parsed.missingFromBrief).toEqual([])
    expect(parsed.bugsSeen).toEqual([])
  })

  it('rejects scores off the scale, which are otherwise silently averaged in', () => {
    expect(() => ScorecardSchema.parse({ ...GOOD_CARD, overall: 11 })).toThrow()
    expect(() =>
      ScorecardSchema.parse({ ...GOOD_CARD, looks: { score: 5, evidence: 'wonderful' } }),
    ).toThrow()
  })
})

describe('buildJudgeMessages', () => {
  const base = {
    brief: 'Dodge falling rocks with the arrow keys, with a score and a game-over screen.',
    metadata: { name: 'Space Dodger', description: 'Dodge rocks.' },
    design: '**Controls** — arrow keys',
    sources: [{ name: 'game.js', text: 'const CONFIG = {}' }],
    probeBefore: HEALTHY,
    probeAfter: HEALTHY,
    consoleErrors: [],
    keysPlayed: ['ArrowLeft', 'ArrowRight'],
    seconds: 12,
    viewport: { width: 1280, height: 800 },
  }

  it('gives the judge the brief, the probe and the source', () => {
    const [, user] = buildJudgeMessages(base)
    const text = (user.content as { type: string; text?: string }[])[0].text ?? ''

    expect(text).toContain('Dodge falling rocks')
    expect(text).toContain('Verdict: running, drawing and listening for input.')
    expect(text).toContain('const CONFIG = {}')
    expect(text).toContain('Space Dodger')
  })

  it('sends the clip as a video part with a sampling rate', () => {
    const [, user] = buildJudgeMessages({
      ...base,
      video: { dataUrl: 'data:video/mp4;base64,AAAA', fps: 2 },
    })
    const parts = user.content as { type: string; video_url?: { url: string }; fps?: number }[]
    const video = parts.find((part) => part.type === 'video_url')

    expect(video?.video_url?.url).toBe('data:video/mp4;base64,AAAA')
    expect(video?.fps).toBe(2)
  })

  it('falls back to stills as image parts', () => {
    const [, user] = buildJudgeMessages({
      ...base,
      frames: ['data:image/png;base64,A', 'data:image/png;base64,B'],
    })
    const parts = user.content as { type: string }[]

    expect(parts.filter((part) => part.type === 'image_url')).toHaveLength(2)
    expect(parts.some((part) => part.type === 'video_url')).toBe(false)
  })

  // Without a recording the model must be told it is blind, or it invents a
  // `looks` score from the source code.
  it('says so when there is nothing to look at', () => {
    const [, user] = buildJudgeMessages(base)
    const parts = user.content as { type: string; text?: string }[]

    expect(parts.at(-1)?.text).toContain('could not see it')
  })

  it('tells the judge the probe outranks its own reading of the video', () => {
    const [system] = buildJudgeMessages(base)

    expect(system.content).toContain('it is right and you are')
  })

  it('keeps a runaway source file from eating the whole request', () => {
    const [, user] = buildJudgeMessages({
      ...base,
      sources: [{ name: 'game.js', text: 'x'.repeat(50_000) }],
    })
    const text = (user.content as { text?: string }[])[0].text ?? ''

    expect(text.length).toBeLessThan(30_000)
    expect(text).toContain('characters cut')
  })
})

describe('clipForPrompt', () => {
  it('leaves a short file alone', () => {
    expect(clipForPrompt('short', 100)).toBe('short')
  })

  // Both ends matter: the top of a game file is its config and the bottom is
  // the loop, and cutting either hides how it starts or whether it runs.
  it('keeps the head and the tail of a long one', () => {
    const clipped = clipForPrompt(`START${'x'.repeat(1000)}END`, 100)

    expect(clipped.startsWith('START')).toBe(true)
    expect(clipped.endsWith('END')).toBe(true)
  })
})

describe('selectSourceFiles', () => {
  it('shows the entry page and the game first, and skips what is not source', () => {
    expect(
      selectSourceFiles(['game.json', 'enemies.js', 'style.css', 'index.html', 'game.js', 'a.png']),
    ).toEqual(['index.html', 'game.js', 'enemies.js', 'style.css'])
  })
})

describe('derivePlayKeys', () => {
  it('plays the keys the plan names', () => {
    expect(derivePlayKeys('**Controls** — WASD to move, space to fire')).toEqual([
      'a',
      'd',
      'w',
      's',
      'Space',
    ])
  })

  // A platformer whose plan spelled its controls this way was played with jump
  // alone, so it never left the start ledge and scored as if it worked.
  it('reads arrow glyphs and letter pairs as movement keys', () => {
    const keys = derivePlayKeys('**Controls** — A/D or ←/→ move; Space/↑/W jump (coyote time)')
    expect(keys).toEqual(expect.arrayContaining(['ArrowLeft', 'ArrowRight', 'a', 'd', 'Space']))
  })

  it('falls back to arrows and space when there is no plan', () => {
    expect(derivePlayKeys(null)).toContain('ArrowLeft')
    expect(derivePlayKeys('# Design\n\nSome prose.')).toContain('Space')
  })
})

describe('planPlay', () => {
  it('holds a direction and taps the rest, going right first', () => {
    const plan = planPlay(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'Enter'])
    expect(plan.steer[0]).toBe('ArrowRight')
    expect(plan.steer).not.toContain('Space')
    expect(plan.act).toEqual(['Space', 'Enter'])
  })

  // A one-button game has nothing to steer with, and tapping its only key is
  // still the whole of playing it.
  it('taps the only key when there is nothing to steer', () => {
    const plan = planPlay(['Space'])
    expect(plan.steer).toEqual([])
    expect(plan.act).toEqual(['Space'])
  })

  // A paddle game has nothing to tap, and tapping the direction it is already
  // holding would only cancel it out.
  it('leaves nothing to tap in a steer-only game', () => {
    expect(planPlay(['ArrowLeft', 'ArrowRight'])).toEqual({
      steer: ['ArrowRight', 'ArrowLeft'],
      act: [],
    })
  })
})

describe('extractJson', () => {
  it('reads a bare object', () => {
    expect(extractJson('{"overall":7}')).toEqual({ overall: 7 })
  })

  it('reads one out of a code fence', () => {
    expect(extractJson('Here you go:\n```json\n{"overall":7}\n```\nHope that helps!')).toEqual({
      overall: 7,
    })
  })

  it('ignores a thinking block that contains its own braces', () => {
    expect(extractJson('<think>maybe {"overall":1}? no</think>{"overall":9}')).toEqual({
      overall: 9,
    })
  })

  // Taking the last `}` in the string would cut a nested object short.
  it('keeps a nested object whole', () => {
    expect(extractJson('{"works":{"score":3},"overall":6} — done')).toEqual({
      works: { score: 3 },
      overall: 6,
    })
  })

  it('is not confused by a brace inside a string', () => {
    expect(extractJson('{"summary":"it draws a } shape"}')).toEqual({
      summary: 'it draws a } shape',
    })
  })

  it('says so when there is no object at all', () => {
    expect(() => extractJson('I cannot judge this game.')).toThrow(/no JSON object/)
  })
})

describe('buildRequestBody', () => {
  it('asks for one complete answer, not a stream', () => {
    const body = buildRequestBody([{ role: 'user', content: 'hi' }], {
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      model: 'Qwen/Qwen3.8-27B',
      temperature: 0.2,
      maxTokens: 2000,
      timeoutMs: 1000,
    })

    expect(body).toMatchObject({ model: 'Qwen/Qwen3.8-27B', stream: false, max_tokens: 2000 })
  })
})

describe('judgeGame', () => {
  const options = {
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'Qwen/Qwen3.8-27B',
    temperature: 0.2,
    maxTokens: 2000,
    timeoutMs: 1000,
  }

  const reply = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

  it('returns the scorecard the model sent', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(reply(JSON.stringify(GOOD_CARD)))

    const result = await judgeGame([{ role: 'user', content: 'go' }], { ...options, fetchImpl })

    expect(result.scorecard.overall).toBe(8)
    expect(result.attempts).toBe(1)
  })

  it('asks once more when the model answers with prose, keeping what it said', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(reply('It is a nice little game.'))
      .mockResolvedValueOnce(reply(JSON.stringify(GOOD_CARD)))

    const result = await judgeGame([{ role: 'user', content: 'go' }], { ...options, fetchImpl })

    expect(result.attempts).toBe(2)
    const retry = JSON.parse(String(fetchImpl.mock.calls[1][1].body)) as {
      messages: { role: string; content: string }[]
    }
    expect(retry.messages.at(-2)).toMatchObject({ role: 'assistant' })
    expect(retry.messages.at(-1)?.content).toContain('ONLY the JSON object')
  })

  it('gives up after the second bad reply rather than paying for a third', async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => reply('nope'))

    await expect(
      judgeGame([{ role: 'user', content: 'go' }], { ...options, fetchImpl }),
    ).rejects.toThrow(/never produced a valid scorecard/)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('surfaces what the provider said when it refuses', async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementation(async () => new Response('model does not support video', { status: 400 }))

    await expect(
      judgeGame([{ role: 'user', content: 'go' }], { ...options, fetchImpl }),
    ).rejects.toThrow(/HTTP 400: model does not support video/)
  })
})

describe('renderReport', () => {
  it('leads with the score and shows what the cap changed', () => {
    const gate = probeGate({ ...HEALTHY, frames: 0 }, { ...HEALTHY, frames: 0 })
    const report = renderReport({
      gameName: 'Space Dodger',
      gameDir: '/games/space-dodger',
      brief: 'Dodge rocks.',
      model: 'Qwen/Qwen3.8-27B',
      scorecard: applyGate(GOOD_CARD, gate),
      raw: GOOD_CARD,
      gate,
      probeAfter: { ...HEALTHY, frames: 0 },
      consoleErrors: ['[uncaught] boom'],
      viewport: { width: 1280, height: 800 },
    })

    expect(report).toContain('**Overall 2/10**')
    expect(report).toContain('Capped by the play-test probe')
    expect(report).toContain('The judge said works 4/4 and overall 8/10')
    expect(report).toContain('[uncaught] boom')
  })

  it('does not mention a cap that never bit', () => {
    const report = renderReport({
      gameName: 'Space Dodger',
      gameDir: '/games/space-dodger',
      brief: 'Dodge rocks.',
      model: 'Qwen/Qwen3.8-27B',
      scorecard: GOOD_CARD,
      raw: GOOD_CARD,
      gate: probeGate(HEALTHY, HEALTHY),
      probeAfter: HEALTHY,
      consoleErrors: [],
      viewport: { width: 1280, height: 800 },
    })

    expect(report).not.toContain('Capped by')
    expect(report).toContain('| Works | 4/4 |')
  })

  // A newline in the evidence would end the table row and drop everything after
  // it out of the report.
  it('keeps evidence inside its table cell', () => {
    const report = renderReport({
      gameName: 'G',
      gameDir: '/g',
      brief: 'b',
      model: 'm',
      scorecard: { ...GOOD_CARD, looks: { score: 2, evidence: 'plain\nbut | tidy' } },
      raw: GOOD_CARD,
      gate: probeGate(HEALTHY, HEALTHY),
      probeAfter: HEALTHY,
      consoleErrors: [],
      viewport: { width: 1280, height: 800 },
    })

    expect(report).toContain('| plain but \\| tidy |')
  })
})
