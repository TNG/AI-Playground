/**
 * llama.cpp speculative-decoding sweep for the local agent presets.
 *
 * Question it answers: which `--spec-type` combination makes Quick Coder
 * finish sooner on the Arc box? We ship `--spec-default --spec-type draft-mtp`
 * today; llama.cpp also offers several draftless n-gram implementations that
 * can be stacked on top of MTP, and the case they are built for — re-emitting
 * code that already appeared in the context — is exactly what the build step of
 * a two-step game turn does.
 *
 * Each arm is a fresh `llama-server` on the Windows test machine (speculation is
 * a startup flag), driven through an SSH port-forward. Every arm replays the
 * same three workloads, taken from one real Quick run:
 *
 *   plan   the first request of the split turn: short answer, thinking on
 *   build  the second: no thinking, one `write` carrying a whole HTML game
 *   full   both of them for real, executing the tool calls, to a finished game
 *
 * Temperature is 0 everywhere, so the arms emit near-identical tokens and the
 * difference between them is speed rather than luck.
 *
 * Usage (from WebUI/, with the packaged app CLOSED so the GPU is free):
 *   node --experimental-strip-types scripts/bench/speculative.mts \
 *     --out ~/aipg-bench/speculative
 *
 *   --host intel-ptl          ssh alias of the test machine
 *   --arms none,mtp,…         subset of the arms below
 *   --repeat 1                measured repeats of plan and build
 *   --skip-full               leave out the end-to-end workload (it is the long one)
 *   --only-full               run only the end-to-end workload
 *   --stall-seconds 120       give up on an arm whose stream goes silent this long
 *   --ctx 32768 --port 39500 --gpu-layers 999
 *   --exe / --model / --mmproj / --work-dir   Windows paths
 *   --dry-run                 build the fixtures, print their size, touch nothing
 *   --report-only [--merge <dir>]  re-render the tables from saved results.json,
 *                             optionally folding a second run's arms in
 *   --allow-other-servers     bench alongside a running app (smoke tests only —
 *                             a second model in memory makes the numbers noise)
 *
 * The method and the verdict live in docs/llamacpp-speculative-benchmark.md.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  buildEditFixture,
  buildQuickFixture,
  fixtureFromSession,
  type EditFixture,
  type OpenAiTool,
} from './speculative/fixtures.ts'
import {
  fatalInLog,
  fetchLog,
  installHelper,
  openTunnel,
  parseDraftStats,
  runningServers,
  startServer,
  stopServer,
  waitForHealth,
  type DraftStats,
  type RemoteConfig,
} from './speculative/remote.ts'

// ── Arms ────────────────────────────────────────────────────────────────────
//
// One server start each. Everything outside `specFlags` is identical, so an arm
// is exactly its speculation config.

type Arm = {
  id: string
  label: string
  specFlags: string[]
  note: string
}

const ARMS: Arm[] = [
  {
    id: 'none',
    label: 'no speculation',
    specFlags: [],
    note: 'Reference. Every speedup below is measured against this.',
  },
  {
    id: 'mtp',
    label: 'draft-mtp',
    specFlags: ['--spec-type', 'draft-mtp'],
    note: "The model's own multi-token-prediction heads, nothing else.",
  },
  {
    id: 'ngram-mod',
    label: 'ngram-mod (--spec-default)',
    specFlags: ['--spec-default'],
    note: 'What --spec-default enables on its own: the shared n-gram hash pool.',
  },
  {
    id: 'mtp-ngram-mod',
    label: 'draft-mtp + ngram-mod',
    specFlags: ['--spec-type', 'draft-mtp,ngram-mod'],
    note: 'MTP with the hash-pool n-grams stacked on top.',
  },
  {
    id: 'mtp-ngram-simple',
    label: 'draft-mtp + ngram-simple',
    // The doc suggests a long draft for source-code rewriting, but 64 does not
    // fit next to a fully offloaded 27B: the fitter aborts before loading.
    specFlags: ['--spec-type', 'draft-mtp,ngram-simple', '--spec-draft-n-max', '16'],
    note: 'MTP plus the simplest history match, the doc\'s "rewriting source code" case.',
  },
  {
    id: 'mtp-ngram-k4v',
    label: 'draft-mtp + ngram-map-k4v',
    specFlags: [
      '--spec-type',
      'draft-mtp,ngram-map-k4v',
      '--spec-ngram-map-k4v-size-n',
      '8',
      '--spec-ngram-map-k4v-size-m',
      '8',
      '--spec-ngram-map-k4v-min-hits',
      '2',
      '--spec-draft-n-max',
      '16',
    ],
    note: 'MTP plus the four-value n-gram map, tuned as the doc suggests for long repeats.',
  },
  {
    id: 'shipped',
    label: '--spec-default --spec-type draft-mtp',
    specFlags: ['--spec-default', '--spec-type', 'draft-mtp'],
    note: 'Exactly what models.json ships today, to see whether --spec-default survives --spec-type.',
  },
]

/** The app's own defaults (llamaCppBackendService.LLAMACPP_DEFAULT_PARAMETERS) plus the
 *  shipped reasoning cap, held constant so only speculation varies. */
const commonFlags = (gpuLayers: number): string[] => [
  '--gpu-layers',
  String(gpuLayers),
  '--log-prefix',
  '--jinja',
  '--no-mmap',
  '-fa',
  'on',
  '--cache-ram',
  '16384',
  '--reasoning-budget',
  '2048',
  '--reasoning-budget-message',
  'I have thought about this long enough. Time to act on what I have.',
]

const DEFAULTS = {
  host: 'intel-ptl',
  port: 39500,
  ctx: 32768,
  exe: 'C:\\AI-Playground-schuettm\\LlamaCPP\\llama-cpp\\llama-server.exe',
  model:
    'C:\\AI-Playground-schuettm\\models\\LLM\\ggufLLM\\unsloth---Qwen3.8-27B-GGUF\\' +
    'Qwen3.8-27B-UD-Q4_K_XL.gguf',
  workDir: 'C:\\Users\\intel-ptl-user\\aipg-spec-bench',
  planTokens: 2048,
  buildTokens: 6144,
  loadTimeoutMs: 900_000,
}

// ── CLI ─────────────────────────────────────────────────────────────────────

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

function num(value: string | undefined, fallback: number, min = 0): number {
  const parsed = Number(value)
  if (value === undefined || !Number.isFinite(parsed) || parsed < min) return fallback
  return parsed
}

// ── Requests ────────────────────────────────────────────────────────────────

type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

/** llama.cpp's own accounting, richer than `usage` and the reason we stream. */
type Timings = {
  prompt_n?: number
  prompt_ms?: number
  cache_n?: number
  predicted_n?: number
  predicted_ms?: number
  predicted_per_second?: number
  draft_n?: number
  draft_n_accepted?: number
}

type ToolCall = { id: string; name: string; arguments: string }

type Measurement = {
  workload: string
  attempt: number
  ttftMs: number
  totalMs: number
  promptTokens: number
  completionTokens: number
  cachedTokens: number
  processedPromptTokens: number
  promptMs: number
  decodedTokens: number
  decodeMs: number
  decodeTokensPerSecond: number
  finishReason: string
  timings: Timings
}

type Turn = {
  measurement: Measurement
  text: string
  toolCalls: ToolCall[]
}

async function chat(options: {
  baseUrl: string
  model: string
  workload: string
  attempt: number
  systemPrompt: string
  messages: ChatMessage[]
  tools: OpenAiTool[]
  maxTokens: number
  thinking: boolean
  reasoningEffort?: string
  stallMs: number
}): Promise<Turn> {
  const started = performance.now()
  // The Arc driver can lose the device mid-decode: the stream simply stops and
  // the socket stays open, which parked a whole sweep for an hour. A silence
  // longer than a few decodes is treated as a dead arm rather than waited on.
  const abort = new AbortController()
  let stallTimer = setTimeout(() => abort.abort(), options.stallMs)
  const keepAlive = () => {
    clearTimeout(stallTimer)
    stallTimer = setTimeout(() => abort.abort(), options.stallMs)
  }
  const response = await fetch(`${options.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal: abort.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      seed: 0,
      max_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      // Mirrors samplingDefaults.chatTemplateKwargs: the toggle is always stated,
      // the effort only when the turn thinks.
      chat_template_kwargs: {
        enable_thinking: options.thinking,
        ...(options.thinking && options.reasoningEffort
          ? { reasoning_effort: options.reasoningEffort }
          : {}),
      },
      messages: [{ role: 'system', content: options.systemPrompt }, ...options.messages],
      tools: options.tools,
    }),
  })
  if (!response.ok || !response.body) {
    throw new Error(`${options.workload}: HTTP ${response.status} ${await response.text()}`)
  }

  let ttftMs = 0
  let text = ''
  let finishReason = ''
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
  let timings: Timings | undefined
  const calls = new Map<number, ToolCall>()

  const decoder = new TextDecoder()
  let buffered = ''
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      keepAlive()
      buffered += decoder.decode(chunk, { stream: true })
      const events = buffered.split('\n')
      buffered = events.pop() ?? ''
      for (const line of events) {
        if (!line.startsWith('data: ')) continue
        const payload = line.slice(6).trim()
        if (payload === '[DONE]') continue
        const event = JSON.parse(payload) as {
          choices?: Array<{
            delta?: {
              content?: string
              reasoning_content?: string
              tool_calls?: Array<{
                index?: number
                id?: string
                function?: { name?: string; arguments?: string }
              }>
            }
            finish_reason?: string | null
          }>
          usage?: { prompt_tokens?: number; completion_tokens?: number }
          timings?: Timings
        }
        if (event.usage) usage = event.usage
        if (event.timings) timings = event.timings
        const choice = event.choices?.[0]
        const delta = choice?.delta
        if (choice?.finish_reason) finishReason = choice.finish_reason
        if (!delta) continue
        if (ttftMs === 0 && Object.keys(delta).length > 0) ttftMs = performance.now() - started
        if (delta.content) text += delta.content
        for (const call of delta.tool_calls ?? []) {
          const index = call.index ?? 0
          const existing = calls.get(index) ?? { id: '', name: '', arguments: '' }
          if (call.id) existing.id = call.id
          if (call.function?.name) existing.name = call.function.name
          if (call.function?.arguments) existing.arguments += call.function.arguments
          calls.set(index, existing)
        }
      }
    }
  } catch (error) {
    if (abort.signal.aborted) {
      throw new Error(
        `${options.workload}: no token for ${Math.round(options.stallMs / 1000)}s after ` +
          `${(performance.now() - started) / 1000}s and ${text.length} characters — server stalled`,
      )
    }
    throw error
  } finally {
    clearTimeout(stallTimer)
  }

  const totalMs = performance.now() - started
  const promptTokens = usage?.prompt_tokens ?? timings?.prompt_n ?? 0
  const decodedTokens = timings?.predicted_n ?? usage?.completion_tokens ?? 0
  const decodeMs = timings?.predicted_ms ?? 0
  return {
    text,
    toolCalls: [...calls.values()].filter((call) => call.name !== ''),
    measurement: {
      workload: options.workload,
      attempt: options.attempt,
      ttftMs,
      totalMs,
      promptTokens,
      completionTokens: usage?.completion_tokens ?? 0,
      cachedTokens: timings?.cache_n ?? 0,
      processedPromptTokens: timings?.prompt_n ?? 0,
      promptMs: timings?.prompt_ms ?? 0,
      decodedTokens,
      decodeMs,
      decodeTokensPerSecond:
        timings?.predicted_per_second ?? (decodeMs > 0 ? (decodedTokens / decodeMs) * 1000 : 0),
      finishReason,
      timings: timings ?? {},
    },
  }
}

// ── Workloads ───────────────────────────────────────────────────────────────

function assistantMessage(turn: Turn): ChatMessage {
  return {
    role: 'assistant',
    content: turn.text,
    ...(turn.toolCalls.length > 0
      ? {
          tool_calls: turn.toolCalls.map((call) => ({
            id: call.id,
            type: 'function' as const,
            function: { name: call.name, arguments: call.arguments },
          })),
        }
      : {}),
  }
}

/**
 * Stand in for the real tools during the end-to-end arm. The results are worded
 * like the app's (`piToolOperations`'s write, `gameStudio`'s game) because the
 * model reads them and a strange answer would change what it does next.
 */
function executeToolCall(call: ToolCall, workspaceDir: string): string {
  let args: Record<string, unknown> = {}
  try {
    args = JSON.parse(call.arguments || '{}') as Record<string, unknown>
  } catch {
    return 'Invalid JSON arguments.'
  }
  if (call.name === 'write') {
    const target = typeof args.path === 'string' ? args.path : 'index.html'
    const content = typeof args.content === 'string' ? args.content : ''
    const file = path.join(workspaceDir, target)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
    return `Successfully wrote ${Buffer.byteLength(content)} bytes to ${target}`
  }
  if (call.name === 'game') {
    if (args.action === 'set_metadata') {
      return `Library card updated: ${String(args.name ?? '')} — ${String(args.description ?? '')}`
    }
    if (args.action === 'set_icon') return 'Cover image set to icon.svg.'
    return 'name: (unset)\ndescription: (none)\nicon: (none)\nsaved to library: not yet'
  }
  return `Unknown tool ${call.name}.`
}

type ArmResult = {
  arm: Arm
  serverArgs: string[]
  measurements: Measurement[]
  full?: {
    turns: number
    wallMs: number
    decodedTokens: number
    gameBytes: number
    finished: boolean
  }
  stats: DraftStats
  error?: string
}

// ── Sweep ───────────────────────────────────────────────────────────────────

async function runArm(options: {
  arm: Arm
  config: RemoteConfig
  baseUrl: string
  fixture: Awaited<ReturnType<typeof buildQuickFixture>>
  editFixture?: EditFixture
  repeat: number
  skipFull: boolean
  onlyFull: boolean
  onlyEdit: boolean
  planTokens: number
  buildTokens: number
  editTokens: number
  stallMs: number
  common: string[]
  outDir: string
}): Promise<ArmResult> {
  const { arm, config, baseUrl, fixture } = options
  const measurements: Measurement[] = []
  let full: ArmResult['full']
  let error: string | undefined

  console.log(`\n── ${arm.id}: ${arm.label}`)
  const server = startServer(config, arm.id, arm.specFlags, options.common)
  console.log(`   server pid ${server.pid}, loading…`)
  try {
    await waitForHealth(baseUrl, DEFAULTS.loadTimeoutMs, () => fatalInLog(config, server))
    const model = await resolveModel(baseUrl)
    console.log(`   ready (${model})`)

    // A first tiny request pays whatever one-off cost the server has left, so it
    // does not land on the first measured one.
    await chat({
      baseUrl,
      model,
      workload: 'warmup',
      attempt: 0,
      systemPrompt: 'You are a benchmark warm-up.',
      messages: [{ role: 'user', content: 'Say ok.' }],
      tools: [],
      maxTokens: 8,
      thinking: false,
      stallMs: options.stallMs,
    })

    for (let attempt = 1; attempt <= (options.onlyFull ? 0 : options.repeat); attempt += 1) {
      if (!options.onlyEdit) await runQuickWorkloads(attempt)
      await runEditWorkload(attempt)
    }

    async function runQuickWorkloads(attempt: number): Promise<void> {
      const plan = await chat({
        baseUrl,
        model,
        workload: 'plan',
        attempt,
        systemPrompt: fixture.systemPrompt,
        messages: [{ role: 'user', content: fixture.brief }],
        tools: fixture.tools,
        maxTokens: options.planTokens,
        thinking: true,
        reasoningEffort: 'low',
        stallMs: options.stallMs,
      })
      measurements.push(plan.measurement)
      console.log(`   plan  #${attempt}  ${describe(plan.measurement)}`)

      const build = await chat({
        baseUrl,
        model,
        workload: 'build',
        attempt,
        systemPrompt: fixture.systemPrompt,
        messages: [
          { role: 'user', content: fixture.brief },
          { role: 'assistant', content: fixture.plan },
          { role: 'user', content: fixture.handoff },
        ],
        tools: fixture.tools,
        maxTokens: options.buildTokens,
        thinking: false,
        stallMs: options.stallMs,
      })
      measurements.push(build.measurement)
      console.log(`   build #${attempt}  ${describe(build.measurement)}`)
    }

    /** Recorded Game Agent turns, each replacing one section of `game.js`. */
    async function runEditWorkload(attempt: number): Promise<void> {
      const editFixture = options.editFixture
      if (!editFixture) return
      for (const [index, step] of editFixture.steps.entries()) {
        const edit = await chat({
          baseUrl,
          model,
          workload: `edit:${step.label}`,
          attempt,
          systemPrompt: editFixture.systemPrompt,
          messages: step.messages,
          tools: editFixture.tools,
          maxTokens: options.editTokens,
          thinking: true,
          reasoningEffort: 'low',
          stallMs: options.stallMs,
        })
        measurements.push(edit.measurement)
        console.log(
          `   edit ${index + 1}/${editFixture.steps.length}  ${describe(edit.measurement)}  ` +
            step.label,
        )
      }
    }

    if (!options.skipFull) {
      full = await runFullGame({
        baseUrl,
        model,
        fixture,
        planTokens: options.planTokens,
        buildTokens: options.buildTokens,
        stallMs: options.stallMs,
        workspaceDir: path.join(options.outDir, 'games', arm.id),
        measurements,
      })
      console.log(
        `   full      ${(full.wallMs / 1000).toFixed(1)}s, ${full.turns} turns, ` +
          `${full.gameBytes} bytes written`,
      )
    }
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure)
    console.log(`   FAILED: ${error}`)
  } finally {
    stopServer(config, server.pid)
  }

  const log = fetchLog(config, server, path.join(options.outDir, 'logs', `${arm.id}.log`))
  const stats = parseDraftStats(log)
  if (stats.acceptanceRate !== null) {
    console.log(
      `   drafting  ${(stats.acceptanceRate * 100).toFixed(1)}% accepted ` +
        `(${stats.accepted}/${stats.generated}), ` +
        `${Object.keys(stats.implementations).join(', ') || 'no per-impl stats'}`,
    )
  }

  return {
    arm,
    serverArgs: [...arm.specFlags, ...options.common],
    measurements,
    ...(full ? { full } : {}),
    stats,
    ...(error ? { error } : {}),
  }
}

/** The two-step turn for real: plan, handoff, build, tool calls, until it stops. */
async function runFullGame(options: {
  baseUrl: string
  model: string
  fixture: Awaited<ReturnType<typeof buildQuickFixture>>
  planTokens: number
  buildTokens: number
  stallMs: number
  workspaceDir: string
  measurements: Measurement[]
}): Promise<NonNullable<ArmResult['full']>> {
  const { fixture } = options
  fs.mkdirSync(options.workspaceDir, { recursive: true })
  const started = performance.now()
  const messages: ChatMessage[] = [{ role: 'user', content: fixture.brief }]
  let decodedTokens = 0
  let turns = 0
  let finished = false

  const plan = await chat({
    baseUrl: options.baseUrl,
    model: options.model,
    workload: 'full-plan',
    attempt: 1,
    systemPrompt: fixture.systemPrompt,
    messages,
    tools: fixture.tools,
    maxTokens: options.planTokens,
    thinking: true,
    reasoningEffort: 'low',
    stallMs: options.stallMs,
  })
  options.measurements.push(plan.measurement)
  decodedTokens += plan.measurement.decodedTokens
  turns += 1
  messages.push(assistantMessage(plan))
  for (const call of plan.toolCalls) {
    messages.push({
      role: 'tool',
      tool_call_id: call.id,
      content: executeToolCall(call, options.workspaceDir),
    })
  }
  messages.push({ role: 'user', content: fixture.handoff })

  // The build is a tool loop: write the game, name it, answer the user. Six
  // steps is well past what a finished Quick run takes.
  for (let step = 1; step <= 6; step += 1) {
    const turn = await chat({
      baseUrl: options.baseUrl,
      model: options.model,
      workload: `full-build-${step}`,
      attempt: 1,
      systemPrompt: fixture.systemPrompt,
      messages,
      tools: fixture.tools,
      maxTokens: options.buildTokens,
      thinking: false,
      stallMs: options.stallMs,
    })
    options.measurements.push(turn.measurement)
    decodedTokens += turn.measurement.decodedTokens
    turns += 1
    messages.push(assistantMessage(turn))
    if (turn.toolCalls.length === 0) {
      finished = true
      break
    }
    for (const call of turn.toolCalls) {
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: executeToolCall(call, options.workspaceDir),
      })
    }
  }

  const game = path.join(options.workspaceDir, 'index.html')
  return {
    turns,
    wallMs: performance.now() - started,
    decodedTokens,
    gameBytes: fs.existsSync(game) ? fs.statSync(game).size : 0,
    finished,
  }
}

function describe(measurement: Measurement): string {
  return (
    `${measurement.decodedTokens} tok @ ${measurement.decodeTokensPerSecond.toFixed(1)} tok/s, ` +
    `prefill ${measurement.processedPromptTokens} tok in ${(measurement.promptMs / 1000).toFixed(1)}s, ` +
    `ttft ${(measurement.ttftMs / 1000).toFixed(1)}s, total ${(measurement.totalMs / 1000).toFixed(1)}s` +
    (measurement.finishReason === 'length' ? ' (TRUNCATED)' : '')
  )
}

async function resolveModel(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/models`)
  const body = (await response.json()) as { data?: Array<{ id?: string }> }
  return body.data?.[0]?.id ?? 'unknown'
}

// ── Report ──────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function forWorkload(result: ArmResult, prefix: string): Measurement[] {
  return result.measurements.filter((measurement) => measurement.workload.startsWith(prefix))
}

/**
 * How much of the drafting paid off, from the server's own counters on each
 * response. The log would say the same thing at exit, but an arm is killed to
 * free the GPU for the next one, so its summary never gets printed.
 */
function drafting(measurements: Measurement[]): { drafted: number; accepted: number } {
  return measurements.reduce(
    (total, measurement) => ({
      drafted: total.drafted + (measurement.timings.draft_n ?? 0),
      accepted: total.accepted + (measurement.timings.draft_n_accepted ?? 0),
    }),
    { drafted: 0, accepted: 0 },
  )
}

function renderReport(results: ArmResult[], context: Record<string, string>): string {
  const baseline = results.find((result) => result.arm.id === 'none')
  const speedup = (result: ArmResult, prefix: string): string => {
    if (!baseline || baseline === result) return '—'
    const reference = median(forWorkload(baseline, prefix).map((m) => m.decodeTokensPerSecond))
    const value = median(forWorkload(result, prefix).map((m) => m.decodeTokensPerSecond))
    if (reference === 0 || value === 0) return '—'
    return `${(value / reference).toFixed(2)}×`
  }
  const decode = (result: ArmResult, prefix: string): string => {
    const values = forWorkload(result, prefix).map((m) => m.decodeTokensPerSecond)
    return values.length === 0 ? '—' : median(values).toFixed(1)
  }

  const lines = [
    '# llama.cpp speculative decoding on Qwen3.8-27B',
    '',
    Object.entries(context)
      .map(([key, value]) => `- **${key}**: ${value}`)
      .join('\n'),
    '',
    "## Decode speed (tok/s, median of the arm's requests)",
    '',
    '| arm | plan | build | edit | full run | build vs none | edit vs none | drafted | accepted |',
    '|---|---|---|---|---|---|---|---|---|',
    ...results.map((result) => {
      const { drafted, accepted } = drafting(result.measurements)
      const share = drafted === 0 ? '—' : `${((accepted / drafted) * 100).toFixed(1)}%`
      return (
        `| \`${result.arm.id}\` ${result.arm.label} | ${decode(result, 'plan')} | ` +
        `${decode(result, 'build')} | ${decode(result, 'edit')} | ${decode(result, 'full')} | ` +
        `${speedup(result, 'build')} | ${speedup(result, 'edit')} | ${drafted} | ${share} |`
      )
    }),
    '',
    // The reason the edit workload exists: writing a new file has nothing in the
    // prompt to copy from, while replacing a section quotes it verbatim. If
    // n-grams help anywhere, the gap between these two columns is where.
    '## Draft acceptance: writing new code vs editing existing code',
    '',
    '| arm | write turns (plan+build) | edit turns |',
    '|---|---|---|',
    ...results.map((result) => {
      const rate = (prefixes: string[]): string => {
        const picked = prefixes.flatMap((prefix) => forWorkload(result, prefix))
        const { drafted, accepted } = drafting(picked)
        if (drafted === 0) return picked.length === 0 ? '—' : 'never drafted'
        return `${((accepted / drafted) * 100).toFixed(1)}% (${accepted}/${drafted})`
      }
      return `| \`${result.arm.id}\` | ${rate(['plan', 'build'])} | ${rate(['edit'])} |`
    }),
    '',
    '## End-to-end game creation',
    '',
    '| arm | wall clock | turns | decoded tokens | game bytes | finished |',
    '|---|---|---|---|---|---|',
    ...results.map((result) => {
      const full = result.full
      if (!full) return `| \`${result.arm.id}\` | — | — | — | — | — |`
      return `| \`${result.arm.id}\` | ${(full.wallMs / 1000).toFixed(1)}s | ${full.turns} | ${
        full.decodedTokens
      } | ${full.gameBytes} | ${full.finished ? 'yes' : 'no'} |`
    }),
    '',
    '## What each arm actually drafted',
    '',
    ...results.flatMap((result) => {
      const perRequest = result.measurements
        .filter((measurement) => (measurement.timings.draft_n ?? 0) > 0)
        .map(
          (measurement) =>
            `  - ${measurement.workload}: ${measurement.timings.draft_n_accepted ?? 0}/${
              measurement.timings.draft_n
            } draft tokens accepted, ${measurement.decodeTokensPerSecond.toFixed(1)} tok/s`,
        )
      const implementations = Object.entries(result.stats.implementations).map(
        ([name, entry]) =>
          `  - log: \`${name}\` ${entry.acceptedTokens}/${entry.generatedTokens} tokens accepted`,
      )
      const body =
        perRequest.length + implementations.length === 0
          ? ['  - never drafted a token']
          : [...perRequest, ...implementations]
      return [`- \`${result.arm.id}\` — ${result.arm.note}`, ...body]
    }),
    '',
  ]
  const failures = results.filter((result) => result.error)
  if (failures.length > 0) {
    lines.push(
      '## Failures',
      '',
      ...failures.map((result) => `- \`${result.arm.id}\`: ${result.error}`),
      '',
    )
  }
  return lines.join('\n')
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const outDir = expandHome(args.out ?? '~/aipg-bench/speculative')
  const config: RemoteConfig = {
    host: args.host ?? DEFAULTS.host,
    exe: args.exe ?? DEFAULTS.exe,
    model: args.model ?? DEFAULTS.model,
    ...(args.mmproj ? { mmproj: args.mmproj } : {}),
    port: num(args.port, DEFAULTS.port, 1),
    ctxSize: num(args.ctx, DEFAULTS.ctx, 512),
    workDir: args['work-dir'] ?? DEFAULTS.workDir,
  }
  const baseUrl = `http://127.0.0.1:${config.port}`
  const repeat = num(args.repeat, 1, 1)
  const planTokens = num(args['plan-tokens'], DEFAULTS.planTokens, 64)
  const buildTokens = num(args['build-tokens'], DEFAULTS.buildTokens, 256)
  const selected = args.arms
    ? args.arms.split(',').map((entry) => entry.trim())
    : ARMS.map((arm) => arm.id)
  const arms = ARMS.filter((arm) => selected.includes(arm.id))
  if (arms.length === 0) throw new Error(`no arms matched ${args.arms}`)

  // Re-render the tables from results already on disk: the sweep costs hours,
  // and how it is presented should not.
  if (args['report-only'] === 'true') {
    const saved = JSON.parse(
      fs.readFileSync(path.join(outDir, 'results.json'), 'utf8'),
    ) as ArmResult[]
    // An arm can be measured across several passes — a retry after a crashed
    // sweep, a later `--only-edit` run — so the report takes a list of result
    // directories and folds them into one row per arm.
    const merged = [
      ...saved,
      ...(args.merge ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry !== '')
        .flatMap(
          (dir) =>
            JSON.parse(
              fs.readFileSync(path.join(expandHome(dir), 'results.json'), 'utf8'),
            ) as ArmResult[],
        ),
    ]
    writeReport(mergeArms(merged), outDir, config, repeat, commonFlags(999))
    return
  }

  const fixture = await buildQuickFixture('bench-model')
  if (args.session) {
    Object.assign(fixture, fixtureFromSession(expandHome(args.session)))
  }
  const editFixture = args['edit-session']
    ? await buildEditFixture({
        model: 'bench-model',
        session: expandHome(args['edit-session']),
        steps: num(args['edit-steps'], 5, 1),
      })
    : undefined
  if (editFixture) {
    console.log(
      `Edit workload: ${editFixture.steps.length} recorded turns ` +
        `(${editFixture.steps.map((step) => step.label).join(', ')})`,
    )
  }
  const approximateTokens = (text: string) => Math.round(text.length / 4)
  console.log(
    `Fixture: system prompt ${fixture.systemPrompt.length} chars ` +
      `(~${approximateTokens(fixture.systemPrompt)} tok), ` +
      `${fixture.tools.length} tools (~${approximateTokens(JSON.stringify(fixture.tools))} tok), ` +
      `brief ~${approximateTokens(fixture.brief)} tok, plan ~${approximateTokens(fixture.plan)} tok`,
  )
  if (args['dry-run'] === 'true') {
    fs.mkdirSync(outDir, { recursive: true })
    fs.writeFileSync(path.join(outDir, 'fixture.json'), JSON.stringify(fixture, null, 2))
    console.log(`Dry run: fixture written to ${path.join(outDir, 'fixture.json')}`)
    return
  }

  fs.mkdirSync(outDir, { recursive: true })
  installHelper(config)
  const stray = args['allow-other-servers'] === 'true' ? [] : runningServers(config)
  if (stray.length > 0) {
    throw new Error(
      `llama-server already running on ${config.host} (pid ${stray.join(', ')}). ` +
        'Close the AI Playground app so the bench owns the GPU, then re-run.',
    )
  }

  const common = commonFlags(num(args['gpu-layers'], 999, 0))
  const tunnel = openTunnel(config)
  const results: ArmResult[] = []
  try {
    for (const arm of arms) {
      results.push(
        await runArm({
          arm,
          config,
          baseUrl,
          fixture,
          ...(editFixture ? { editFixture } : {}),
          repeat,
          skipFull:
            (args['skip-full'] === 'true' || args['only-edit'] === 'true') &&
            args['only-full'] !== 'true',
          onlyFull: args['only-full'] === 'true',
          onlyEdit: args['only-edit'] === 'true',
          planTokens,
          buildTokens,
          editTokens: num(args['edit-tokens'], 1536, 128),
          stallMs: num(args['stall-seconds'], 120, 10) * 1000,
          common,
          outDir,
        }),
      )
      fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2))
    }
  } finally {
    tunnel.close()
  }

  writeReport(results, outDir, config, repeat, common)
}

/**
 * A later `--only-full` pass produces a second result for arms already measured;
 * folding them together keeps one row per arm instead of two half-empty ones.
 */
function mergeArms(results: ArmResult[]): ArmResult[] {
  const byArm = new Map<string, ArmResult>()
  for (const result of results) {
    const existing = byArm.get(result.arm.id)
    if (!existing) {
      byArm.set(result.arm.id, result)
      continue
    }
    existing.measurements = [...existing.measurements, ...result.measurements]
    if (result.full) existing.full = result.full
  }
  return [...byArm.values()]
}

function writeReport(
  results: ArmResult[],
  outDir: string,
  config: RemoteConfig,
  repeat: number,
  common: string[],
): void {
  const report = renderReport(results, {
    model: path.basename(config.model),
    machine: `${config.host} (Arc B390)`,
    context: `${config.ctxSize} tokens`,
    'repeats per workload': String(repeat),
    sampling: 'temperature 0, seed 0',
    'common flags': common.join(' '),
    generated: new Date().toISOString(),
  })
  const reportPath = path.join(outDir, 'report.md')
  fs.writeFileSync(reportPath, report)
  console.log(`\n${report}\nWritten to ${reportPath}`)
}

await main()
