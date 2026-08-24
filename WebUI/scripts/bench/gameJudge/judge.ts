import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ScorecardSchema, type JudgeMessage, type Scorecard } from './rubric.ts'

// ── Asking a cloud model ─────────────────────────────────────────────────────
//
// One OpenAI-compatible `POST /chat/completions`, with the clip as a `video_url`
// content part — the shape Qwen's own docs use and the one OpenRouter forwards.
// It is deliberately a cloud call: the whole point of judging is a second
// opinion from a model that did not build the thing, and vision decode inside
// the local agent loop is what preceded every ErrorDeviceLost crash in the 35B
// benchmark runs. Nothing here ever runs during a Game Agent session.
//
// Getting the video accepted is the fiddly part. Playwright records webm, which
// most providers do not take (DashScope and OpenRouter both list mp4 and
// friends), so the clip is transcoded when an ffmpeg can be found and the run
// falls back to the stills the collector took otherwise. Base64 is used rather
// than a URL because there is nowhere to host a file from a laptop, and that
// caps the payload at a few megabytes — Qwen's documented ceiling for an inline
// video is 7 MB before encoding.

const MAX_INLINE_VIDEO_BYTES = 7 * 1024 * 1024
const MAX_INLINE_FRAME_BYTES = 6 * 1024 * 1024
/** Base64 costs four characters per three bytes, and the limit is on what is sent. */
const BASE64_GROWTH = 4 / 3

export type MediaPayload = {
  video?: { dataUrl: string; fps: number }
  frames?: string[]
  /** What was sent and why, for the run log. */
  note: string
  /** Kept for the artifacts directory. */
  mp4Path?: string
}

export type PrepareMediaOptions = {
  videoPath: string | null
  framePaths: string[]
  fps: number
  outDir: string
  ffmpegPath?: string
  /** Skip the clip and send stills, for providers that take no video. */
  framesOnly?: boolean
}

/**
 * An ffmpeg to transcode with: the one the caller named, the one on PATH, or the
 * one Playwright already downloaded for its own recording (which is why a
 * machine that can run this harness usually has one without installing anything).
 */
export function findFfmpeg(explicit?: string): string | null {
  const candidates = [explicit, 'ffmpeg', ...playwrightFfmpegCandidates()].filter(
    (candidate): candidate is string => Boolean(candidate),
  )
  for (const candidate of candidates) {
    try {
      const probe = spawnSync(candidate, ['-version'], { stdio: 'ignore' })
      if (probe.status === 0) return candidate
    } catch {
      continue
    }
  }
  return null
}

function playwrightFfmpegCandidates(): string[] {
  const root =
    process.env.PLAYWRIGHT_BROWSERS_PATH ||
    (process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
      : process.platform === 'win32'
        ? path.join(os.homedir(), 'AppData', 'Local', 'ms-playwright')
        : path.join(os.homedir(), '.cache', 'ms-playwright'))
  let entries: string[]
  try {
    entries = fs.readdirSync(root).filter((entry) => entry.startsWith('ffmpeg-'))
  } catch {
    return []
  }
  const binary =
    process.platform === 'darwin'
      ? 'ffmpeg-mac'
      : process.platform === 'win32'
        ? 'ffmpeg-win64.exe'
        : 'ffmpeg-linux'
  return entries
    .map((entry) => path.join(root, entry, binary))
    .filter((file) => fs.existsSync(file))
}

function dataUrl(file: string, mime: string): string {
  return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
}

/** Decide what the judge is actually shown, and say so. */
export function prepareMedia(options: PrepareMediaOptions): MediaPayload {
  const frames = () => framePayload(options.framePaths)
  if (options.framesOnly || !options.videoPath || !fs.existsSync(options.videoPath)) {
    const payload = frames()
    return {
      ...payload,
      note: options.framesOnly
        ? `${options.framePaths.length} stills (video suppressed by --frames-only)`
        : `${options.framePaths.length} stills (no recording was produced)`,
    }
  }

  const ffmpeg = findFfmpeg(options.ffmpegPath)
  if (!ffmpeg) {
    return {
      ...frames(),
      note: `${options.framePaths.length} stills (no ffmpeg to transcode with)`,
    }
  }
  const mp4Path = path.join(options.outDir, 'play.mp4')
  // Small on purpose: the model samples a couple of frames a second anyway, so
  // the pixels beyond that are payload budget spent on nothing.
  const transcode = spawnSync(
    ffmpeg,
    [
      '-y',
      '-i',
      options.videoPath,
      '-an',
      '-vf',
      'scale=640:-2',
      '-r',
      '15',
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      mp4Path,
    ],
    { stdio: 'ignore' },
  )
  if (transcode.status !== 0 || !fs.existsSync(mp4Path)) {
    return {
      ...frames(),
      note: `${options.framePaths.length} stills (ffmpeg could not produce an mp4)`,
    }
  }
  const bytes = fs.statSync(mp4Path).size
  if (bytes * BASE64_GROWTH > MAX_INLINE_VIDEO_BYTES) {
    return {
      ...frames(),
      mp4Path,
      note: `${options.framePaths.length} stills (the clip was ${mb(bytes)}, over the inline limit)`,
    }
  }
  return {
    video: { dataUrl: dataUrl(mp4Path, 'video/mp4'), fps: options.fps },
    mp4Path,
    note: `an mp4 clip of ${mb(bytes)} at ${options.fps} fps`,
  }
}

function framePayload(framePaths: string[]): { frames: string[] } {
  let kept = framePaths
  // Halving beats truncating: the judge should see the whole play, thinner.
  while (kept.length > 2 && totalBytes(kept) * BASE64_GROWTH > MAX_INLINE_FRAME_BYTES) {
    kept = kept.filter((_file, index) => index % 2 === 0)
  }
  return { frames: kept.map((file) => dataUrl(file, mimeOf(file))) }
}

function mimeOf(file: string): string {
  return /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png'
}

function totalBytes(files: string[]): number {
  return files.reduce((total, file) => total + fs.statSync(file).size, 0)
}

function mb(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── The request ──────────────────────────────────────────────────────────────

export type JudgeOptions = {
  baseUrl: string
  apiKey: string
  model: string
  temperature: number
  maxTokens: number
  timeoutMs: number
  /** Injected by the tests; defaults to global fetch. */
  fetchImpl?: typeof fetch
}

export type JudgeResult = {
  scorecard: Scorecard
  /** What the model actually replied, kept for the artifacts. */
  reply: string
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  attempts: number
}

type ChatResponse = {
  choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>
  usage?: JudgeResult['usage']
  error?: { message?: string }
}

export function buildRequestBody(
  messages: JudgeMessage[],
  options: JudgeOptions,
): Record<string, unknown> {
  return {
    model: options.model,
    messages,
    temperature: options.temperature,
    max_tokens: options.maxTokens,
    stream: false,
  }
}

/**
 * Pull the object out of a reply that may be fenced, prefixed with a thinking
 * block, or followed by a paragraph of politeness. Scanning for the matching
 * brace rather than taking the last one in the string keeps a JSON object that
 * quotes a `}` intact.
 */
export function extractJson(reply: string): unknown {
  const withoutThinking = reply.replace(/<think>[\s\S]*?<\/think>/gi, '')
  const fenced = withoutThinking.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const text = fenced ? fenced[1] : withoutThinking
  const start = text.indexOf('{')
  if (start === -1) throw new Error('the reply contained no JSON object')
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const character = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = inString
      continue
    }
    if (character === '"') {
      inString = !inString
      continue
    }
    if (inString) continue
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return JSON.parse(text.slice(start, index + 1))
    }
  }
  throw new Error('the reply held an unterminated JSON object')
}

function replyText(body: ChatResponse): string {
  const content = body.choices?.[0]?.message?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((part) => part.text ?? '').join('')
  return ''
}

async function postOnce(
  messages: JudgeMessage[],
  options: JudgeOptions,
): Promise<{ reply: string; usage?: JudgeResult['usage'] }> {
  const call = options.fetchImpl ?? fetch
  const response = await call(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: JSON.stringify(buildRequestBody(messages, options)),
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  const raw = await response.text()
  if (!response.ok) {
    throw new Error(`the judge returned HTTP ${response.status}: ${raw.slice(0, 600)}`)
  }
  let body: ChatResponse
  try {
    body = JSON.parse(raw) as ChatResponse
  } catch {
    throw new Error(`the judge returned something that is not JSON: ${raw.slice(0, 300)}`)
  }
  if (body.error?.message) throw new Error(`the judge refused: ${body.error.message}`)
  const reply = replyText(body)
  if (!reply.trim()) throw new Error('the judge replied with nothing')
  return { reply, usage: body.usage }
}

const CORRECTION =
  'That was not a scorecard I can read. Reply with ONLY the JSON object described above — no' +
  ' prose, no code fence — with every axis present and each score a whole number in range.'

/**
 * Score one game. A malformed reply is worth exactly one more try: the fix is
 * always the same sentence, and a model that ignores it twice is not going to
 * be argued into it on a third attempt costing another video upload.
 */
export async function judgeGame(
  messages: JudgeMessage[],
  options: JudgeOptions,
): Promise<JudgeResult> {
  let conversation = messages
  let lastError: unknown
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const { reply, usage } = await postOnce(conversation, options)
    try {
      return {
        scorecard: ScorecardSchema.parse(extractJson(reply)),
        reply,
        usage,
        attempts: attempt,
      }
    } catch (error) {
      lastError = error
      conversation = [
        ...conversation,
        { role: 'assistant', content: reply },
        { role: 'user', content: CORRECTION },
      ]
    }
  }
  throw new Error(
    `the judge never produced a valid scorecard: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  )
}
