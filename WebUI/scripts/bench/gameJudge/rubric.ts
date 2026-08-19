import { z } from 'zod'
import {
  formatProbeReport,
  MIN_INK,
  type ProbeReport,
} from '../../../electron/agentMode/previewProbe.ts'

// ── The rubric ───────────────────────────────────────────────────────────────
//
// Two layers, because the four questions are not the same kind of question.
// "Does it look good" and "does it match the brief" need judgement and a model
// is the only thing that can give it. "Does it run" is a fact, and a model asked
// to look at a clip of a black rectangle will cheerfully report a working game —
// which is why the probe's findings are not merely quoted into the prompt but
// CAP the score afterwards. The model can lower `works`; it cannot raise it past
// what the page demonstrably did.

const AxisSchema = z.object({
  score: z.number().int().min(0).max(4),
  /** One sentence naming what in the clip earned that score. */
  evidence: z.string(),
})

export const ScorecardSchema = z.object({
  works: AxisSchema,
  brief: AxisSchema,
  looks: AxisSchema,
  bugs: AxisSchema,
  overall: z.number().int().min(0).max(10),
  /** Things the brief asked for that are not in the game. */
  missingFromBrief: z.array(z.string()).default([]),
  /** Defects visible while playing. */
  bugsSeen: z.array(z.string()).default([]),
  summary: z.string(),
})

export type Scorecard = z.infer<typeof ScorecardSchema>

export const AXES = ['works', 'brief', 'looks', 'bugs'] as const
export type Axis = (typeof AXES)[number]

// ── The deterministic gate ───────────────────────────────────────────────────

export type ProbeGate = {
  /** Highest `works` score the page's own behaviour supports. */
  worksCap: number
  /** Highest overall score that follows from it. */
  overallCap: number
  /** Why, in the judge's own words, for the report. */
  reasons: string[]
}

const NO_CAP: ProbeGate = { worksCap: 4, overallCap: 10, reasons: [] }

function inputListeners(report: ProbeReport): string[] {
  return (report.listeners ?? []).filter((type) => /^(key|pointer|mouse|touch|click)/.test(type))
}

/** The message without its stack: a reason is one line of a bullet list. */
function firstLine(error: string | undefined): string {
  if (!error) return ''
  const line = error.split('\n')[0].trim()
  return line.length > 160 ? `${line.slice(0, 160)}…` : line
}

function gateFrom(worksCap: number, reason: string): ProbeGate {
  // A game that does not run cannot be a good game, however it photographs.
  return { worksCap, overallCap: worksCap >= 4 ? 10 : worksCap * 2, reasons: [reason] }
}

/**
 * What the two probes allow the `works` axis to be.
 *
 * Both probes are consulted rather than just the later one, because a loop that
 * legitimately stops at a game-over screen looks identical to a frozen one if
 * you only look at the end — so a cap is only applied when NEITHER probe saw the
 * thing happen. The rules are in previewProbe's verdict order for its reason: an
 * exception explains a frozen loop and a frozen loop explains a blank canvas, so
 * testing them this way round names the cause instead of the symptom.
 *
 * The floor is 1 rather than 0 on purpose. A cap should only remove what the
 * page disproved, and "broken" is all the probe establishes; whether that is a 0
 * or a 1 is a judgement, and the model keeps it.
 */
export function probeGate(before: ProbeReport, after: ProbeReport): ProbeGate {
  if (!before.installed && !after.installed) {
    return {
      ...NO_CAP,
      reasons: ['The play-test probe never installed, so nothing could be verified.'],
    }
  }
  const errorCount = Math.max(before.errorCount ?? 0, after.errorCount ?? 0)
  if (errorCount > 0) {
    const first = firstLine((after.errors ?? before.errors ?? [])[0])
    return gateFrom(
      1,
      `The page threw while running (${errorCount} uncaught${first ? `, first: ${first}` : ''}).`,
    )
  }
  if (Math.max(before.frames ?? 0, after.frames ?? 0) === 0) {
    return gateFrom(1, 'Nothing ever animated: no requestAnimationFrame callbacks in either probe.')
  }
  const inks = [before.canvas?.ink, after.canvas?.ink].filter(
    (ink): ink is number => typeof ink === 'number',
  )
  if (inks.length > 0 && Math.max(...inks) < MIN_INK) {
    return gateFrom(1, 'The canvas stayed effectively blank throughout.')
  }
  const listeners = new Set([...inputListeners(before), ...inputListeners(after)])
  if (listeners.size === 0) {
    return gateFrom(2, 'The page listens for no input at all, so it cannot be played.')
  }
  return NO_CAP
}

/** Clamp a judged scorecard to what the page actually demonstrated. */
export function applyGate(scorecard: Scorecard, gate: ProbeGate): Scorecard {
  if (gate.worksCap >= 4 && gate.overallCap >= 10) return scorecard
  return {
    ...scorecard,
    works: { ...scorecard.works, score: Math.min(scorecard.works.score, gate.worksCap) },
    overall: Math.min(scorecard.overall, gate.overallCap),
  }
}

// ── The prompt ───────────────────────────────────────────────────────────────

const RUBRIC = [
  'Score each axis 0-4, using these anchors:',
  '',
  'works — is it a game you can play?',
  '  0 blank, frozen, or throwing on load.',
  '  1 something is drawn but nothing responds; there is no play.',
  '  2 it responds, but a core piece of the loop is missing (no way to lose or win, no',
  '    scoring, or it gets stuck).',
  '  3 a complete loop you can play, with rough edges.',
  '  4 start, play, lose or win, and carry on or restart — all present and working.',
  '',
  'brief — is it what was asked for?',
  '  0 unrelated to the request.',
  '  1 right genre, most of the asked-for elements missing.',
  '  2 about half the asked-for elements are there.',
  '  3 nearly all of them; something minor is missing.',
  '  4 everything the brief named is present and recognisable.',
  '',
  'looks — does it look good?',
  '  0 untouched default or empty screen.',
  '  1 crude: unreadable text, colours that fight, overlapping elements.',
  '  2 plain but clean and legible.',
  '  3 a deliberate palette, readable HUD, some motion or effects.',
  '  4 polished: coherent art direction, effects, and feedback for what the player does.',
  '',
  'bugs — how buggy is it? (4 is clean)',
  '  0 defects make it unplayable.',
  '  1 severe: constant glitches, collisions that do not work, state running away.',
  '  2 several visible problems.',
  '  3 a minor glitch or two.',
  '  4 nothing visibly wrong in the clip.',
  '',
  'Then give `overall` 0-10 as your summary judgement of the game as delivered. Weight',
  '`works` and `brief` above `looks`: a beautiful thing that does not play is not a good game.',
].join('\n')

const RESPONSE_SHAPE = [
  'Reply with one JSON object and nothing else:',
  '',
  '{',
  '  "works":  { "score": 0-4, "evidence": "one sentence citing what you saw" },',
  '  "brief":  { "score": 0-4, "evidence": "..." },',
  '  "looks":  { "score": 0-4, "evidence": "..." },',
  '  "bugs":   { "score": 0-4, "evidence": "..." },',
  '  "overall": 0-10,',
  '  "missingFromBrief": ["asked-for thing that is not there", "..."],',
  '  "bugsSeen": ["what went wrong", "..."],',
  '  "summary": "two or three sentences for the person who asked for this game"',
  '}',
].join('\n')

export const JUDGE_SYSTEM_PROMPT = [
  'You are judging a browser game that an AI coding agent built from a one-line brief.',
  'You are shown a recording of the game being played automatically (a script clicks once,',
  'then holds the game keys and moves the pointer), stills from that recording, the source',
  'the agent wrote, and an automated play-test report taken from inside the page.',
  '',
  'Judge the game that was delivered, not the effort behind it. Be concrete and be strict:',
  'this score is used to compare models and prompts against each other, so a merely working',
  'game is a middling one, not a good one.',
  '',
  'Two things to keep straight:',
  '- The play-test report is measured from inside the page (uncaught errors, animation frames,',
  '  how much of the canvas is painted, which input events are bound, what a keypress changed).',
  '  Treat it as fact. If it disagrees with your reading of the video, it is right and you are',
  '  wrong — most often because the recording caught a title screen or a game-over screen.',
  '- The player is a script, not a person. It cannot read instructions, so a game that needs a',
  '  specific unexplained action may look more broken than it is. Say so in your evidence',
  '  rather than silently marking it down. But do not use it as a blanket excuse: it holds one',
  '  direction at a time while tapping the action key, which is enough to move, jump, shoot and',
  '  steer. If it moves and still cannot get anywhere — a jump that never clears the first',
  '  platform, a gap that cannot be crossed, a hitbox that kills on contact — read the source and',
  '  say whether the numbers in the game make progress possible at all. An unwinnable game is a',
  '  severe gameplay bug, and the source is where you can prove it.',
  '',
  RUBRIC,
  '',
  RESPONSE_SHAPE,
].join('\n')

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'video_url'; video_url: { url: string }; fps?: number }

export type JudgeMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | ContentPart[]
}

export type GameSourceFile = { name: string; text: string }

export type JudgeInput = {
  /** What the user asked the agent to build. */
  brief: string
  /** `game.json`, as the library shows it. */
  metadata: { name: string; description: string } | null
  design: string | null
  sources: GameSourceFile[]
  probeBefore: ProbeReport
  probeAfter: ProbeReport
  consoleErrors: string[]
  keysPlayed: string[]
  seconds: number
  /** The window it was played in — a fraction-scaled level plays differently. */
  viewport: { width: number; height: number }
  /** The clip, when a container the provider accepts was produced. */
  video?: { dataUrl: string; fps: number }
  /** Stills, used alone when there is no usable clip. */
  frames?: string[]
}

/** Files worth showing the judge: what the agent wrote, not what it generated. */
export function selectSourceFiles(names: string[]): string[] {
  return names
    .filter((name) => /\.(html?|js|css)$/i.test(name))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

function rank(name: string): number {
  if (/^index\.html?$/i.test(name)) return 0
  if (/^game\.js$/i.test(name)) return 1
  if (/\.js$/i.test(name)) return 2
  if (/\.css$/i.test(name)) return 3
  return 4
}

/** Keep a file readable while it cannot run away with the context window. */
export function clipForPrompt(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  const head = Math.floor(maxChars * 0.6)
  const tail = maxChars - head
  return `${text.slice(0, head)}\n\n… ${text.length - maxChars} characters cut …\n\n${text.slice(-tail)}`
}

const MAX_FILE_CHARS = 8000
const MAX_SOURCE_CHARS = 24000
const MAX_DESIGN_CHARS = 4000
const MAX_CONSOLE_LINES = 10

function sourceSection(sources: GameSourceFile[]): string {
  const parts: string[] = []
  let budget = MAX_SOURCE_CHARS
  for (const file of sources) {
    if (budget <= 0) {
      parts.push(`### ${file.name}\n\n(not shown — prompt budget spent)`)
      continue
    }
    const text = clipForPrompt(file.text, Math.min(MAX_FILE_CHARS, budget))
    budget -= text.length
    parts.push(`### ${file.name}\n\n\`\`\`\n${text}\n\`\`\``)
  }
  return parts.join('\n\n')
}

/** The whole request to the judge, media last so the text frames what it sees. */
export function buildJudgeMessages(input: JudgeInput): JudgeMessage[] {
  const lines: string[] = [
    '## The brief',
    '',
    input.brief.trim(),
    '',
    '## The library card the agent wrote',
    '',
    input.metadata
      ? `Title: ${input.metadata.name}\nDescription: ${input.metadata.description || '(none)'}`
      : '(the agent never named the game)',
    '',
    '## Play-test report, on load',
    '',
    '```',
    formatProbeReport(input.probeBefore),
    '```',
    '',
    `## Play-test report, after ${input.seconds}s of play`,
    '',
    `Played in a ${input.viewport.width}x${input.viewport.height} browser window, the size Play` +
      ' opens a game at. A level laid out in fractions of the canvas but moved with speeds in' +
      ' px/s changes difficulty with the window: check whether the jump or dash still covers the' +
      ' gaps at this size, and call it out if it does not.',
    '',
    `The script played with ${input.keysPlayed.join(', ')}: it holds one direction at a time` +
      ' (never two at once, right first) while tapping the action key twice, and it clicks and' +
      ' moves the pointer. That is unskilled but valid play, so treat it as a beginner at the' +
      ' controls, not as broken input.',
    '',
    '```',
    formatProbeReport(input.probeAfter),
    '```',
    '',
    '## Console',
    '',
    input.consoleErrors.length === 0
      ? '(nothing)'
      : ['```', ...input.consoleErrors.slice(0, MAX_CONSOLE_LINES), '```'].join('\n'),
    '',
    '## design.md, the agent’s own plan',
    '',
    input.design ? clipForPrompt(input.design, MAX_DESIGN_CHARS) : '(the agent wrote no plan)',
    '',
    '## Source',
    '',
    input.sources.length > 0 ? sourceSection(input.sources) : '(no source files found)',
  ]

  const content: ContentPart[] = [{ type: 'text', text: lines.join('\n') }]
  if (input.video) {
    content.push({
      type: 'text',
      text: `\n## The game being played\n\nA ${input.seconds}s recording follows.`,
    })
    content.push({
      type: 'video_url',
      video_url: { url: input.video.dataUrl },
      fps: input.video.fps,
    })
  } else if (input.frames && input.frames.length > 0) {
    content.push({
      type: 'text',
      text:
        `\n## The game being played\n\n${input.frames.length} stills follow, in order, ` +
        `evenly spaced across ${input.seconds}s of play.`,
    })
    for (const frame of input.frames) content.push({ type: 'image_url', image_url: { url: frame } })
  } else {
    content.push({
      type: 'text',
      text:
        '\n## The game being played\n\nNo recording is available for this run. Judge `works`,' +
        ' `brief` and `bugs` from the play-test report and the source, and say in the `looks`' +
        ' evidence that you could not see it.',
    })
  }

  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    { role: 'user', content },
  ]
}

// ── The report ───────────────────────────────────────────────────────────────

const AXIS_TITLES: Record<Axis, string> = {
  works: 'Works',
  brief: 'Matches the brief',
  looks: 'Looks',
  bugs: 'Free of bugs',
}

export type ReportInput = {
  gameName: string
  gameDir: string
  brief: string
  model: string
  scorecard: Scorecard
  raw: Scorecard
  gate: ProbeGate
  probeAfter: ProbeReport
  consoleErrors: string[]
  viewport: { width: number; height: number }
}

export function renderReport(input: ReportInput): string {
  const { scorecard } = input
  const lines = [
    `# Game judge — ${input.gameName}`,
    '',
    `**Overall ${scorecard.overall}/10**`,
    '',
    `Brief: ${input.brief.trim()}`,
    '',
    `Folder: \`${input.gameDir}\` · Judge: \`${input.model}\` ·` +
      ` Played at ${input.viewport.width}x${input.viewport.height}`,
    '',
    '| Axis | Score | Evidence |',
    '| --- | --- | --- |',
  ]
  for (const axis of AXES) {
    const cell = scorecard[axis]
    lines.push(`| ${AXIS_TITLES[axis]} | ${cell.score}/4 | ${escapeCell(cell.evidence)} |`)
  }
  lines.push('', scorecard.summary, '')

  if (scorecard.missingFromBrief.length > 0) {
    lines.push('## Missing from the brief', '')
    for (const item of scorecard.missingFromBrief) lines.push(`- ${item}`)
    lines.push('')
  }
  if (scorecard.bugsSeen.length > 0) {
    lines.push('## Bugs seen', '')
    for (const item of scorecard.bugsSeen) lines.push(`- ${item}`)
    lines.push('')
  }
  if (input.gate.reasons.length > 0) {
    lines.push('## Capped by the play-test probe', '')
    for (const reason of input.gate.reasons) lines.push(`- ${reason}`)
    if (
      input.raw.works.score !== scorecard.works.score ||
      input.raw.overall !== scorecard.overall
    ) {
      lines.push(
        '',
        `The judge said works ${input.raw.works.score}/4 and overall ${input.raw.overall}/10; ` +
          `capped to ${scorecard.works.score}/4 and ${scorecard.overall}/10.`,
      )
    }
    lines.push('')
  }

  lines.push(
    '## Play-test report, after play',
    '',
    '```',
    formatProbeReport(input.probeAfter),
    '```',
  )
  if (input.consoleErrors.length > 0) {
    lines.push(
      '',
      '## Console',
      '',
      '```',
      ...input.consoleErrors.slice(0, MAX_CONSOLE_LINES),
      '```',
    )
  }
  return lines.join('\n')
}

function escapeCell(text: string): string {
  return text.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|')
}
