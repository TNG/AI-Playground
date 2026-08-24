/**
 * Game Agent judge: score a finished game the way a person would be asked to.
 *
 * Question it answers: is the game the agent just built any good? Does it run,
 * does it match what was asked for, does it look like anything, how buggy is it.
 * The 2026-08-14 benchmark measured turns, tokens and crashes and deliberately
 * made no quality judgement, because scoring twelve games by hand is a day's
 * work; this is that day's work, automated, so a change to the preset, the
 * scaffold or the model can be argued about with numbers.
 *
 * It scores games that already exist. It does not run Game Agent, and it never
 * shows a picture to the agent — the play-test loop stays text (see
 * `previewProbe.ts` for why).
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench/gameJudge.mts \
 *     --game ~/AI-Playground/games/space-dodger \
 *     --brief "Make a game where the player dodges falling rocks…" \
 *     --out ~/aipg-bench/game-judge/space-dodger
 *
 *   --fixture rocks|asteroids   use one of the benchmark briefs instead of --brief
 *   --brief-file <path>         read the brief from a file
 *   --dry-run                   play and record, skip the cloud call
 *   --frames-only               send stills rather than a clip
 *   --seconds 12                how long to play
 *   --frames 8                  stills taken across the play
 *   --viewport 1280x800         the browser window to play in; it changes the game
 *   --headed                    watch it play
 *   --base-url / --model / --api-key
 *
 * The API key also comes from TRUSTEDTOKENS_API_KEY or OPENAI_API_KEY.
 * The method and the verdicts live in docs/agent-capability-benchmark.md.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectPlaySession,
  DEFAULT_VIEWPORT,
  derivePlayKeys,
  type Viewport,
} from './gameJudge/collect.ts'
import { judgeGame, prepareMedia } from './gameJudge/judge.ts'
import {
  applyGate,
  buildJudgeMessages,
  probeGate,
  renderReport,
  selectSourceFiles,
  type GameSourceFile,
} from './gameJudge/rubric.ts'

// The briefs the benchmark runs used, so a judged run can be compared with the
// numbers already in docs/agent-capability-benchmark.md.
const FIXTURES: Record<string, string> = {
  rocks:
    'Make a small browser game where the player dodges falling rocks with the arrow keys, with' +
    ' a score and a game-over screen.',
  asteroids:
    'Generate a vector game of asteroids in a single html file, make it colorful with modern' +
    ' effects like particles, etc',
}

const DEFAULT_BASE_URL = 'https://api.trustedtokens.eu/v1'
const DEFAULT_MODEL = 'Qwen/Qwen3.8-27B'

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [key, inlineValue] = token.slice(2).split('=')
    const next = argv[index + 1]
    if (inlineValue !== undefined) {
      args[key] = inlineValue
      continue
    }
    if (next && !next.startsWith('--')) {
      args[key] = next
      index += 1
      continue
    }
    args[key] = 'true'
  }
  return args
}

function expandHome(target: string): string {
  return target.startsWith('~') ? path.join(os.homedir(), target.slice(1)) : target
}

/**
 * A flag given without a value parses as `true`, and `Number('true')` is NaN —
 * which reaches Playwright as a timeout and fails a run twenty seconds in for a
 * reason nobody would guess. Bad numbers fall back to the default instead.
 */
function num(value: string | undefined, fallback: number, min = 0): number {
  const parsed = Number(value)
  if (value === undefined || !Number.isFinite(parsed) || parsed < min) return fallback
  return parsed
}

function parseViewport(value: string | undefined): Viewport {
  const match = /^(\d+)x(\d+)$/.exec(value ?? '')
  if (!match) return DEFAULT_VIEWPORT
  return { width: Number(match[1]), height: Number(match[2]) }
}

function readIfPresent(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8')
  } catch {
    return null
  }
}

type GameCard = { name: string; description: string; entry: string }

function readGameCard(gameDir: string): GameCard | null {
  const raw = readIfPresent(path.join(gameDir, 'game.json'))
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<GameCard>
    return {
      name: parsed.name ?? path.basename(gameDir),
      description: parsed.description ?? '',
      entry: parsed.entry ?? 'index.html',
    }
  } catch {
    return null
  }
}

/** The files the agent wrote, from the game folder itself (not `generated/`). */
function readSources(gameDir: string): GameSourceFile[] {
  let names: string[]
  try {
    names = fs
      .readdirSync(gameDir, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  return selectSourceFiles(names).map((name) => ({
    name,
    text: readIfPresent(path.join(gameDir, name)) ?? '',
  }))
}

function resolveBrief(args: Record<string, string>): string {
  if (args.brief && args.brief !== 'true') return args.brief
  if (args['brief-file']) {
    const file = expandHome(args['brief-file'])
    const text = readIfPresent(file)
    if (!text) throw new Error(`Cannot read the brief at ${file}`)
    return text
  }
  const fixture = args.fixture
  if (fixture) {
    const brief = FIXTURES[fixture]
    if (!brief) {
      throw new Error(`Unknown fixture "${fixture}". Known: ${Object.keys(FIXTURES).join(', ')}`)
    }
    return brief
  }
  throw new Error('Pass the brief the game was built from: --brief, --brief-file or --fixture.')
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (!args.game) throw new Error('Pass the game folder to judge: --game <path>')

  const gameDir = path.resolve(expandHome(args.game))
  if (!fs.existsSync(gameDir)) throw new Error(`No such game folder: ${gameDir}`)
  const brief = resolveBrief(args)
  const card = readGameCard(gameDir)
  const entry = args.entry ?? card?.entry ?? 'index.html'
  if (!fs.existsSync(path.join(gameDir, entry))) {
    throw new Error(
      `The game has no ${entry} to open. Pass --entry if it is called something else.`,
    )
  }

  const outDir = path.resolve(expandHome(args.out ?? path.join(os.tmpdir(), 'aipg-game-judge')))
  fs.mkdirSync(outDir, { recursive: true })

  const design = readIfPresent(path.join(gameDir, 'design.md'))
  const keys = args.keys ? args.keys.split(',').filter(Boolean) : derivePlayKeys(design)
  const seconds = num(args.seconds, 12, 1)
  const frameCount = num(args.frames, 8, 1)
  const viewport = parseViewport(args.viewport)

  console.log(`judging ${card?.name ?? path.basename(gameDir)} (${gameDir})`)
  console.log(
    `playing ${entry} for ${seconds}s at ${viewport.width}x${viewport.height} with ${keys.join(', ')}…`,
  )

  const session = await collectPlaySession({
    gameDir,
    entry,
    artifactsDir: outDir,
    seconds,
    frameCount,
    keys,
    headed: args.headed === 'true',
    viewport,
  })

  fs.writeFileSync(
    path.join(outDir, 'probe.json'),
    `${JSON.stringify(
      {
        game: { dir: gameDir, entry, card },
        brief,
        keysPlayed: session.keysPlayed,
        seconds,
        viewport: session.viewport,
        probeBefore: session.probeBefore,
        probeAfter: session.probeAfter,
        consoleErrors: session.consoleErrors,
      },
      null,
      2,
    )}\n`,
  )

  const gate = probeGate(session.probeBefore, session.probeAfter)
  for (const reason of gate.reasons) console.log(`probe gate: ${reason}`)
  if (session.consoleErrors.length > 0) {
    console.log(`${session.consoleErrors.length} console error(s) while playing`)
  }

  const media = prepareMedia({
    videoPath: session.videoPath,
    framePaths: session.framePaths,
    fps: num(args.fps, 2, 0.1),
    outDir,
    ffmpegPath: args.ffmpeg,
    framesOnly: args['frames-only'] === 'true',
  })
  console.log(`judge will see ${media.note}`)

  const messages = buildJudgeMessages({
    brief,
    metadata: card ? { name: card.name, description: card.description } : null,
    design,
    sources: readSources(gameDir),
    probeBefore: session.probeBefore,
    probeAfter: session.probeAfter,
    consoleErrors: session.consoleErrors,
    keysPlayed: session.keysPlayed,
    seconds,
    viewport: session.viewport,
    video: media.video,
    frames: media.frames,
  })

  if (args['dry-run'] === 'true') {
    // The prompt without its payload: enough to read and diff, small enough to
    // open. The clip and stills are already on disk next to it.
    fs.writeFileSync(
      path.join(outDir, 'judge-request.json'),
      `${JSON.stringify(messages, elideMedia, 2)}\n`,
    )
    console.log(`\ndry run — artifacts in ${outDir}`)
    console.log(`prompt text is ${promptChars(messages)} characters`)
    return
  }

  const apiKey = args['api-key'] ?? process.env.TRUSTEDTOKENS_API_KEY ?? process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error(
      'No API key. Pass --api-key, or set TRUSTEDTOKENS_API_KEY / OPENAI_API_KEY. Use --dry-run' +
        ' to play and record without judging.',
    )
  }
  const model = args.model ?? DEFAULT_MODEL
  const baseUrl = args['base-url'] ?? DEFAULT_BASE_URL
  console.log(`asking ${model} at ${baseUrl}…`)

  const result = await judgeGame(messages, {
    baseUrl,
    apiKey,
    model,
    temperature: num(args.temperature, 0.2),
    maxTokens: num(args['max-tokens'], 2000, 1),
    timeoutMs: num(args.timeout, 300_000, 1000),
  })

  const scorecard = applyGate(result.scorecard, gate)
  const report = renderReport({
    gameName: card?.name ?? path.basename(gameDir),
    gameDir,
    brief,
    model,
    scorecard,
    raw: result.scorecard,
    gate,
    probeAfter: session.probeAfter,
    consoleErrors: session.consoleErrors,
    viewport: session.viewport,
  })

  fs.writeFileSync(
    path.join(outDir, 'scorecard.json'),
    `${JSON.stringify(
      {
        game: { name: card?.name ?? path.basename(gameDir), dir: gameDir },
        brief,
        judge: {
          model,
          baseUrl,
          attempts: result.attempts,
          usage: result.usage,
          media: media.note,
        },
        gate,
        judged: result.scorecard,
        scorecard,
      },
      null,
      2,
    )}\n`,
  )
  fs.writeFileSync(path.join(outDir, 'report.md'), `${report}\n`)

  console.log(`\n${report}\n`)
  console.log(`artifacts in ${outDir}`)
}

/** Media parts are megabytes of base64; the saved prompt keeps their shape only. */
function elideMedia(key: string, value: unknown): unknown {
  if ((key === 'video_url' || key === 'image_url') && value && typeof value === 'object') {
    const url = (value as { url?: string }).url ?? ''
    return { url: `<${url.slice(0, url.indexOf(',') + 1)}… ${url.length} chars>` }
  }
  return value
}

function promptChars(messages: ReturnType<typeof buildJudgeMessages>): number {
  return messages.reduce((total, message) => {
    if (typeof message.content === 'string') return total + message.content.length
    return (
      total +
      message.content.reduce(
        (inner, part) => inner + (part.type === 'text' ? part.text.length : 0),
        0,
      )
    )
  }, 0)
}

try {
  await main()
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
