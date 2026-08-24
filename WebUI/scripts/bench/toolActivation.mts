/**
 * Agent Mode capability activation benchmark.
 *
 * Question it answers: is it cheaper to expose every capability's tools from the
 * first turn (eager), or to keep them dormant behind one-line summaries and
 * activate a group mid-session (lazy, via Pi's setActiveTools)?
 *
 * The catch with lazy activation is that Pi rebuilds the system prompt when the
 * active tool set changes, and llama.cpp caches the prompt PREFIX — so changing
 * the tools invalidates the whole cached conversation and the next request
 * re-processes it from scratch. This measures that trade-off against the
 * per-request token overhead of always-on schemas.
 *
 * The system prompts and tool schemas are the real ones: a Pi AgentSession is
 * built exactly like piAgentManager.ts builds it, then its system prompt and
 * tool registry are read out and sent to llama.cpp directly, so the numbers
 * describe the app and not an approximation of it.
 *
 * Usage:
 *   node --experimental-strip-types scripts/bench/toolActivation.mts \
 *     [--base-url http://127.0.0.1:39100] [--model <id>] [--repeat 3] \
 *     [--variants A,B,C] [--out ../docs/agent-activation-report.md]
 *
 * The method and the verdict live in docs/agent-capability-benchmark.md; `--out`
 * writes the raw tables next to it, so pick a different file than that one.
 *
 * Start a server first, e.g. (from the repo root):
 *   LlamaCPP/llama-cpp/llama-server -m <model.gguf> -c 32768 -ngl 99 \
 *     --host 127.0.0.1 --port 39100 --parallel 1
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
  type AgentSession,
  type ToolDefinition,
} from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'

// ── Fixtures mirroring production ────────────────────────────────────────────
//
// Snapshots of the prompt text the app appends (piWorkspaceRuntime.ts's
// buildWorkspaceInstructions) and of the capability tools that live behind
// Electron imports (piCustomTools.ts's browser tool, agentBridge.ts's `media`
// spec). Copied rather than imported because those modules pull in `electron`,
// which cannot load in a plain Node process. Only their SIZE and SHAPE matter
// here, but keep them in sync when the originals change materially.

const PROVIDER = 'bench-local'
const WORKSPACE_PREVIEW_URL = 'http://127.0.0.1:41234/'

function workspaceInstructions(cwd: string, workspaceDir: string): string {
  return [
    'You are working inside a project workspace.',
    `- Your working directory is ${cwd}; it maps to ${workspaceDir} on the host, which is where` +
      ' the user sees the files.',
    '- Your file tools (read, edit, write, ls, grep, find, bash) operate RELATIVE to this' +
      ' workspace. Prefer workspace-relative paths like "index.html" or "src/app.js"; writes' +
      ' outside the workspace are rejected.',
    '- Your bash tool is an emulated shell with the usual file/text utilities plus python3 and a' +
      ' `js` interpreter for scripting. It has no network and no node/npm, so you cannot install' +
      ' packages, and you never need to start a web server — one is already running (see below).',
    `- A local static web server already serves this workspace at: ${WORKSPACE_PREVIEW_URL}`,
    '- To view or debug a web page you created, open it with the browser tool — pass just the' +
      ` file name ("index.html") and it resolves against that server, or the full URL` +
      ` ${WORKSPACE_PREVIEW_URL}index.html — NOT a file:// path (file:// URLs hit` +
      ' cross-origin/loading restrictions). After editing a file, reload the same page; the' +
      ' server sends no-cache headers so you always see the latest version.',
    '- Typical web debug loop: open the page with the browser tool, read the console messages to' +
      ' find the error, edit the workspace file to fix it, reload the same URL, and re-check the' +
      ' console until it is clean.',
  ].join('\n')
}

const BROWSER_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['open', 'console', 'eval', 'screenshot'],
      description:
        'open: navigate to `url` (clears previous logs); console: read console ' +
        'messages and uncaught errors since the last open; eval: run `script` in the ' +
        'page and return its result; screenshot: save a PNG of the page into the ' +
        'workspace and return its path.',
    },
    url: {
      type: 'string',
      description:
        'Page to open (action=open): either a workspace-relative path like "index.html" ' +
        '(resolved against the workspace preview server) or a full http URL.',
    },
    script: { type: 'string', description: 'JavaScript to evaluate (action=eval).' },
  },
  required: ['action'],
}

const MEDIA_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    request: {
      type: 'string',
      description:
        'The media request in natural language. Include everything relevant: subject, style, ' +
        'aspect ratio or size wishes, quality level, and any follow-up transformation ' +
        '(edit / animate / convert to 3D).',
    },
    sourceImagePath: {
      type: 'string',
      description:
        'Workspace-relative path of a source image to transform (e.g. ' +
        '"generated/AIPG_00001_.png"). Omit for pure text-to-media generation.',
    },
  },
  required: ['request'],
}

const BROWSER_DESCRIPTION =
  "Drive a headless browser (the app's built-in Chromium) to preview and debug web pages you " +
  'created in the workspace. Open pages via the workspace HTTP preview URL (from your ' +
  'instructions), never file:// paths.'

const MEDIA_DESCRIPTION =
  'Create or transform media (images, videos, 3D models) via a media specialist. Describe the ' +
  'desired result in natural language; the specialist picks the workflow and parameters and ' +
  'can chain steps in one call (e.g. "generate an image of a castle and turn it into a 3D ' +
  'model"). To transform an existing image, pass its workspace-relative path in ' +
  '"sourceImagePath".\n\nFILES: Generated media is automatically saved into the "generated/" ' +
  'folder of your workspace. The tool result lists the workspace-relative paths in "savedFiles".'

/** Skills as the app announces them: name + description now, body on demand. */
const SKILLS = [
  {
    name: 'browser-debugging',
    description:
      'Preview and debug a web page you built in the workspace: open it, read console errors, ' +
      'fix the file, reload, and screenshot.',
  },
  {
    name: 'media-generation',
    description:
      'Create or transform images, videos and 3D models with the `media` tool; results are ' +
      'saved into the workspace.',
  },
]

function skillsPromptSection(names: string[]): string {
  const included = SKILLS.filter((skill) => names.includes(skill.name))
  if (included.length === 0) return ''
  const lines = [
    'The following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    '',
    '<available_skills>',
  ]
  for (const skill of included) {
    lines.push('  <skill>')
    lines.push(`    <name>${skill.name}</name>`)
    lines.push(`    <description>${skill.description}</description>`)
    lines.push(`    <location>/skills/${skill.name}/SKILL.md</location>`)
    lines.push('  </skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

/**
 * What a dormant capability costs in the system prompt: one line each, plus the
 * sentence that tells the model how to wake one up. This is the whole point of
 * lazy activation, so it is measured rather than guessed.
 */
const DORMANT_SUMMARIES = [
  'Extra capabilities are available but not loaded. Call the `capabilities` tool with',
  '{"action":"activate","id":"<id>"} to load one\'s tools before using it.',
  '',
  '<dormant_capabilities>',
  '  <capability id="media">Generate or transform images, videos and 3D models.</capability>',
  '  <capability id="web-debug">Preview and debug web pages in a real browser.</capability>',
  '</dormant_capabilities>',
].join('\n')

const CAPABILITIES_TOOL_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['list', 'activate'], description: 'What to do.' },
    id: { type: 'string', description: 'Capability id to activate (action=activate).' },
  },
  required: ['action'],
}

// ── Tool definitions ────────────────────────────────────────────────────────

/** The app's file/shell builtins, in the same order piToolOperations builds them. */
function coreToolDefinitions(cwd: string): ToolDefinition[] {
  return [
    createReadToolDefinition(cwd),
    createWriteToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createGrepToolDefinition(cwd),
    createFindToolDefinition(cwd),
    createLsToolDefinition(cwd),
  ] as ToolDefinition[]
}

function passthroughTool(
  name: string,
  description: string,
  schema: Record<string, unknown>,
): ToolDefinition {
  return defineTool({
    name,
    label: name,
    description,
    parameters: Type.Unsafe(schema),
    execute: async () => ({ content: [{ type: 'text', text: '' }], details: undefined }),
  }) as ToolDefinition
}

// ── llama.cpp client ────────────────────────────────────────────────────────

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

type OpenAiTool = {
  type: 'function'
  function: { name: string; description: string; parameters: unknown }
}

type RequestMeasurement = {
  label: string
  /** Tokens the model was given (system prompt + transcript + tool schemas). */
  promptTokens: number
  /** Prefix llama.cpp reused from its cache. */
  cachedTokens: number
  /** Prefix it had to process again — the cost of a changed system prompt. */
  processedTokens: number
  promptMs: number
  ttftMs: number
  completionTokens: number
  totalMs: number
}

function toOpenAiTools(definitions: ToolDefinition[]): OpenAiTool[] {
  return definitions.map((definition) => ({
    type: 'function',
    function: {
      name: definition.name,
      description: definition.description,
      // Pi parameters are TypeBox schemas, which ARE JSON Schema objects.
      parameters: definition.parameters as unknown,
    },
  }))
}

async function measureRequest(options: {
  baseUrl: string
  model: string
  label: string
  systemPrompt: string
  messages: ChatMessage[]
  tools: OpenAiTool[]
  maxTokens: number
}): Promise<RequestMeasurement> {
  const started = performance.now()
  const response = await fetch(`${options.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: options.model,
      temperature: 0,
      max_tokens: options.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      // Thinking would dominate the timings and varies per turn; the question
      // here is prefill cost, so keep generation short and deterministic.
      chat_template_kwargs: { enable_thinking: false },
      messages: [{ role: 'system', content: options.systemPrompt }, ...options.messages],
      ...(options.tools.length > 0 ? { tools: options.tools } : {}),
    }),
  })
  if (!response.ok || !response.body) {
    throw new Error(`llama.cpp request failed: ${response.status} ${await response.text()}`)
  }

  let ttftMs = 0
  let usage: { prompt_tokens?: number; completion_tokens?: number } | undefined
  let timings: { cache_n?: number; prompt_n?: number; prompt_ms?: number } | undefined
  const decoder = new TextDecoder()
  let buffered = ''
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true })
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue
      const payload = line.slice(6).trim()
      if (payload === '[DONE]') continue
      const event = JSON.parse(payload) as {
        choices?: Array<{ delta?: Record<string, unknown> }>
        usage?: { prompt_tokens?: number; completion_tokens?: number }
        timings?: { cache_n?: number; prompt_n?: number; prompt_ms?: number }
      }
      if (event.usage) usage = event.usage
      if (event.timings) timings = event.timings
      const delta = event.choices?.[0]?.delta
      if (ttftMs === 0 && delta && Object.keys(delta).length > 0) {
        ttftMs = performance.now() - started
      }
    }
  }

  const promptTokens = usage?.prompt_tokens ?? 0
  const cachedTokens = timings?.cache_n ?? 0
  return {
    label: options.label,
    promptTokens,
    cachedTokens,
    processedTokens: timings?.prompt_n ?? promptTokens - cachedTokens,
    promptMs: timings?.prompt_ms ?? 0,
    ttftMs,
    completionTokens: usage?.completion_tokens ?? 0,
    totalMs: performance.now() - started,
  }
}

/**
 * Isolate one run from every other run's prompt cache. llama.cpp only exposes
 * cache erasure when started with `--slot-save-path`, which the app's own server
 * is not, so instead each run puts a unique line at the very top of the system
 * prompt: nothing cached by a previous run can be reused, and the first request
 * of every variant pays an honest cold prefill. Reuse WITHIN a run is
 * unaffected, which is exactly what is being compared.
 */
function runTag(variant: Variant, attempt: number): string {
  return `Session reference: ${variant}-${attempt}-${Math.random().toString(36).slice(2, 8)}.`
}

// ── Scenario ────────────────────────────────────────────────────────────────
//
// Two steps, the reference agentic flow: write a haiku, then illustrate it. The
// transcript is FIXED (canned assistant text and tool calls) so every variant
// measures the same token counts and differs only in when tools arrive. Real
// generation still happens for every request, so TTFT and decode are real.

const HAIKU_REQUEST = 'Write a haiku about a lighthouse in a winter storm. Just the haiku.'
const CANNED_HAIKU =
  'Salt spray on cold glass\nthe beam sweeps the black water\nwinter holds its breath'
const IMAGE_REQUEST =
  'Now create an image based on that haiku and save it in the workspace, then tell me the file name.'
const CANNED_MEDIA_ARGS = JSON.stringify({
  request:
    'A lighthouse in a winter storm at night, salt spray on cold glass, the beam sweeping black ' +
    'water, moody photorealistic, 16:9',
})
const CANNED_MEDIA_RESULT = JSON.stringify({
  success: true,
  summary: 'Generated 1 image.',
  savedFiles: ['generated/AIPG_00001_.png'],
})
const CANNED_ACTIVATE_ARGS = JSON.stringify({ action: 'activate', id: 'media' })
const CANNED_ACTIVATE_RESULT =
  'Activated capability "media". Its tools are now available: media. ' +
  'Use them directly from here on.'

function assistantToolCall(id: string, name: string, args: string): ChatMessage {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: args } }],
  }
}

type Variant = 'A' | 'B' | 'C'

type VariantResult = {
  variant: Variant
  description: string
  requests: RequestMeasurement[]
}

// ── Pi-derived prompts and tool sets ────────────────────────────────────────

type PromptSet = {
  /** System prompt with only the core file/shell tools active. */
  core: string
  /** Core plus the media capability's tools active. */
  activated: string
  /** Core, media and web-debug all active from the start. */
  eager: string
  coreTools: ToolDefinition[]
  activatedTools: ToolDefinition[]
  eagerTools: ToolDefinition[]
}

/**
 * Build a real Pi session (same options as piAgentManager.createSession) and
 * read its system prompt for each tool set. Nothing is prompted through Pi;
 * it is used only as the authority on what the model actually sees.
 */
async function buildPromptSet(baseUrl: string, model: string): Promise<PromptSet> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-bench-'))
  const workspaceDir = path.join(root, 'workspace')
  const agentDir = path.join(root, 'agent')
  fs.mkdirSync(workspaceDir, { recursive: true })
  fs.mkdirSync(agentDir, { recursive: true })

  const models = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: null,
  })
  models.registerProvider(PROVIDER, {
    name: 'bench llama.cpp',
    baseUrl: `${baseUrl}/v1`,
    api: 'openai-completions',
    apiKey: 'unused',
    models: [
      {
        id: model,
        name: model,
        reasoning: false,
        input: ['text'],
        contextWindow: 32768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      },
    ],
  })
  await models.setRuntimeApiKey(PROVIDER, 'unused')
  const registered = models.getModel(PROVIDER, model)
  if (!registered) throw new Error('failed to register the bench model with Pi')

  const core = coreToolDefinitions(workspaceDir)
  const browser = passthroughTool('browser', BROWSER_DESCRIPTION, BROWSER_SCHEMA)
  const media = passthroughTool('media', MEDIA_DESCRIPTION, MEDIA_SCHEMA)
  const capabilities = passthroughTool(
    'capabilities',
    'List the agent capabilities available in this session and activate one so its tools ' +
      'become callable.',
    CAPABILITIES_TOOL_SCHEMA,
  )

  const promptFor = async (
    tools: ToolDefinition[],
    active: string[],
    appended: string[],
  ): Promise<string> => {
    const resourceLoader = new DefaultResourceLoader({
      cwd: workspaceDir,
      agentDir,
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      noSkills: true,
      appendSystemPrompt: appended.filter((section) => section !== ''),
    })
    await resourceLoader.reload()
    const { session } = await createAgentSession({
      cwd: workspaceDir,
      agentDir,
      model: registered,
      modelRuntime: models,
      sessionManager: SessionManager.inMemory(workspaceDir),
      settingsManager: SettingsManager.inMemory(),
      noTools: 'builtin',
      customTools: tools,
      resourceLoader,
    })
    session.setActiveToolsByName(active)
    const prompt = systemPromptOf(session)
    session.dispose()
    return prompt
  }

  const instructions = workspaceInstructions('/workspace', workspaceDir)
  const coreNames = core.map((tool) => tool.name)
  const eagerTools = [...core, browser, media]
  const activatedTools = [...core, capabilities, media]
  const coreTools = [...core, capabilities]

  return {
    core: await promptFor(
      coreTools,
      [...coreNames, 'capabilities'],
      [instructions, DORMANT_SUMMARIES],
    ),
    activated: await promptFor(
      activatedTools,
      [...coreNames, 'capabilities', 'media'],
      [instructions, skillsPromptSection(['media-generation'])],
    ),
    eager: await promptFor(
      eagerTools,
      [...coreNames, 'browser', 'media'],
      [instructions, skillsPromptSection(['browser-debugging', 'media-generation'])],
    ),
    coreTools,
    activatedTools,
    eagerTools,
  }
}

/** Pi keeps the composed prompt on the agent state; typed loosely on purpose. */
function systemPromptOf(session: AgentSession): string {
  const state = (session.agent as unknown as { state?: { systemPrompt?: string } }).state
  const prompt = state?.systemPrompt
  if (!prompt) throw new Error('Pi session exposed no system prompt')
  return prompt
}

// ── Variants ───────────────────────────────────────────────────────────────

function tagged(tag: string, prompt: string): string {
  return `${tag}\n\n${prompt}`
}

async function runVariantA(
  baseUrl: string,
  model: string,
  prompts: PromptSet,
  tag: string,
): Promise<VariantResult> {
  const tools = toOpenAiTools(prompts.eagerTools)
  const eager = tagged(tag, prompts.eager)
  const requests: RequestMeasurement[] = []

  const transcript: ChatMessage[] = [{ role: 'user', content: HAIKU_REQUEST }]
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R1 haiku',
      systemPrompt: eager,
      messages: transcript,
      tools,
      maxTokens: 64,
    }),
  )
  transcript.push({ role: 'assistant', content: CANNED_HAIKU })
  transcript.push({ role: 'user', content: IMAGE_REQUEST })
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R2 media call',
      systemPrompt: eager,
      messages: transcript,
      tools,
      maxTokens: 96,
    }),
  )
  transcript.push(assistantToolCall('call-media', 'media', CANNED_MEDIA_ARGS))
  transcript.push({ role: 'tool', tool_call_id: 'call-media', content: CANNED_MEDIA_RESULT })
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R3 final answer',
      systemPrompt: eager,
      messages: transcript,
      tools,
      maxTokens: 64,
    }),
  )
  return {
    variant: 'A',
    description: 'Eager: every capability tool active from the first request.',
    requests,
  }
}

async function runVariantB(
  baseUrl: string,
  model: string,
  prompts: PromptSet,
  tag: string,
): Promise<VariantResult> {
  const dormantTools = toOpenAiTools(prompts.coreTools)
  const activeTools = toOpenAiTools(prompts.activatedTools)
  const dormant = tagged(tag, prompts.core)
  const activated = tagged(tag, prompts.activated)
  const requests: RequestMeasurement[] = []

  const transcript: ChatMessage[] = [{ role: 'user', content: HAIKU_REQUEST }]
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R1 haiku',
      systemPrompt: dormant,
      messages: transcript,
      tools: dormantTools,
      maxTokens: 64,
    }),
  )
  transcript.push({ role: 'assistant', content: CANNED_HAIKU })
  transcript.push({ role: 'user', content: IMAGE_REQUEST })
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R2 activate call',
      systemPrompt: dormant,
      messages: transcript,
      tools: dormantTools,
      maxTokens: 96,
    }),
  )
  // The activation round trip, and with it the new system prompt: everything
  // cached so far is now stale.
  transcript.push(assistantToolCall('call-cap', 'capabilities', CANNED_ACTIVATE_ARGS))
  transcript.push({ role: 'tool', tool_call_id: 'call-cap', content: CANNED_ACTIVATE_RESULT })
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R3 media call (after activation)',
      systemPrompt: activated,
      messages: transcript,
      tools: activeTools,
      maxTokens: 96,
    }),
  )
  transcript.push(assistantToolCall('call-media', 'media', CANNED_MEDIA_ARGS))
  transcript.push({ role: 'tool', tool_call_id: 'call-media', content: CANNED_MEDIA_RESULT })
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R4 final answer',
      systemPrompt: activated,
      messages: transcript,
      tools: activeTools,
      maxTokens: 64,
    }),
  )
  return {
    variant: 'B',
    description: 'Lazy: dormant summaries, model activates the capability itself (extra turn).',
    requests,
  }
}

async function runVariantC(
  baseUrl: string,
  model: string,
  prompts: PromptSet,
  tag: string,
): Promise<VariantResult> {
  const dormantTools = toOpenAiTools(prompts.coreTools)
  const activeTools = toOpenAiTools(prompts.activatedTools)
  const dormant = tagged(tag, prompts.core)
  const activated = tagged(tag, prompts.activated)
  const requests: RequestMeasurement[] = []

  const transcript: ChatMessage[] = [{ role: 'user', content: HAIKU_REQUEST }]
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R1 haiku',
      systemPrompt: dormant,
      messages: transcript,
      tools: dormantTools,
      maxTokens: 64,
    }),
  )
  transcript.push({ role: 'assistant', content: CANNED_HAIKU })
  transcript.push({ role: 'user', content: IMAGE_REQUEST })
  // Host-side activation: same prompt change as B, without spending a turn on it.
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R2 media call (host-activated)',
      systemPrompt: activated,
      messages: transcript,
      tools: activeTools,
      maxTokens: 96,
    }),
  )
  transcript.push(assistantToolCall('call-media', 'media', CANNED_MEDIA_ARGS))
  transcript.push({ role: 'tool', tool_call_id: 'call-media', content: CANNED_MEDIA_RESULT })
  requests.push(
    await measureRequest({
      baseUrl,
      model,
      label: 'R3 final answer',
      systemPrompt: activated,
      messages: transcript,
      tools: activeTools,
      maxTokens: 64,
    }),
  )
  return {
    variant: 'C',
    description: 'Lazy, host-activated: same prompt swap as B without the extra turn.',
    requests,
  }
}

// ── Reporting ───────────────────────────────────────────────────────────────

const round = (value: number) => Math.round(value)

function medianOf(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

/** Median each field across repeats of the same variant, request by request. */
function summarize(runs: VariantResult[]): VariantResult {
  const first = runs[0]
  const requests = first.requests.map((request, index) => ({
    label: request.label,
    promptTokens: medianOf(runs.map((run) => run.requests[index].promptTokens)),
    cachedTokens: medianOf(runs.map((run) => run.requests[index].cachedTokens)),
    processedTokens: medianOf(runs.map((run) => run.requests[index].processedTokens)),
    promptMs: medianOf(runs.map((run) => run.requests[index].promptMs)),
    ttftMs: medianOf(runs.map((run) => run.requests[index].ttftMs)),
    completionTokens: medianOf(runs.map((run) => run.requests[index].completionTokens)),
    totalMs: medianOf(runs.map((run) => run.requests[index].totalMs)),
  }))
  return { variant: first.variant, description: first.description, requests }
}

function markdownTable(result: VariantResult): string {
  const lines = [
    `### Variant ${result.variant} — ${result.description}`,
    '',
    '| Request | Prompt tokens | Cached | Re-processed | Prefill ms | TTFT ms | Out tokens | Total ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const request of result.requests) {
    lines.push(
      `| ${request.label} | ${round(request.promptTokens)} | ${round(request.cachedTokens)} | ` +
        `${round(request.processedTokens)} | ${round(request.promptMs)} | ${round(request.ttftMs)} | ` +
        `${round(request.completionTokens)} | ${round(request.totalMs)} |`,
    )
  }
  const totals = result.requests.reduce(
    (accumulator, request) => ({
      processed: accumulator.processed + request.processedTokens,
      ttft: accumulator.ttft + request.ttftMs,
      total: accumulator.total + request.totalMs,
    }),
    { processed: 0, ttft: 0, total: 0 },
  )
  lines.push(
    `| **totals** | | | **${round(totals.processed)}** | | **${round(totals.ttft)}** | | ` +
      `**${round(totals.total)}** |`,
  )
  lines.push('')
  return lines.join('\n')
}

function parseArgs(argv: string[]): Record<string, string> {
  const args: Record<string, string> = {}
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [key, inlineValue] = token.slice(2).split('=')
    args[key] = inlineValue ?? argv[++index] ?? 'true'
  }
  return args
}

async function discoverBaseUrl(explicit?: string): Promise<string> {
  if (explicit) return explicit.replace(/\/$/, '')
  for (let port = 39100; port <= 39110; port += 1) {
    const candidate = `http://127.0.0.1:${port}`
    try {
      const response = await fetch(`${candidate}/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) return candidate
    } catch {
      continue
    }
  }
  for (let port = 39000; port <= 39010; port += 1) {
    const candidate = `http://127.0.0.1:${port}`
    try {
      const response = await fetch(`${candidate}/health`, {
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) return candidate
    } catch {
      continue
    }
  }
  throw new Error('No llama.cpp server found. Pass --base-url http://host:port.')
}

async function resolveModel(baseUrl: string, explicit?: string): Promise<string> {
  if (explicit) return explicit
  const response = await fetch(`${baseUrl}/v1/models`)
  const body = (await response.json()) as { data?: Array<{ id?: string }> }
  const id = body.data?.[0]?.id
  if (!id) throw new Error('Server reported no models; pass --model.')
  return id
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const baseUrl = await discoverBaseUrl(args['base-url'])
  const model = await resolveModel(baseUrl, args.model)
  const repeat = Number(args.repeat ?? 3)
  const variants = (args.variants ?? 'A,B,C').split(',') as Variant[]

  console.log(`server ${baseUrl}, model ${model}, ${repeat} repeat(s)`)
  const prompts = await buildPromptSet(baseUrl, model)
  console.log(
    `system prompt chars — core+dormant ${prompts.core.length}, activated ${prompts.activated.length}, eager ${prompts.eager.length}`,
  )

  const runners: Record<Variant, typeof runVariantA> = {
    A: runVariantA,
    B: runVariantB,
    C: runVariantC,
  }
  const summaries: VariantResult[] = []
  for (const variant of variants) {
    const runs: VariantResult[] = []
    for (let attempt = 0; attempt < repeat; attempt += 1) {
      process.stdout.write(`variant ${variant} run ${attempt + 1}/${repeat}… `)
      const result = await runners[variant](baseUrl, model, prompts, runTag(variant, attempt))
      runs.push(result)
      console.log('done')
    }
    summaries.push(summarize(runs))
  }

  const report = [
    '# Agent capability activation benchmark',
    '',
    `Model \`${model}\` on \`${baseUrl}\`, medians of ${repeat} run(s) per variant, thinking off,`,
    'temperature 0, fixed transcript (identical token counts across variants).',
    '',
    'Prompts and tool schemas come from a real Pi `AgentSession` built like',
    '`piAgentManager.createSession`, so the numbers describe the app. Each run carries a unique',
    'first line in its system prompt, so no run inherits the prompt cache of another run.',
    '',
    ...summaries.map(markdownTable),
  ].join('\n')

  console.log(`\n${report}`)
  const out = args.out
  if (out) {
    const target = path.resolve(out)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${report}\n`)
    console.log(`report written to ${target}`)
  }
  console.log(JSON.stringify({ model, baseUrl, repeat, summaries }, null, 2))
}

await main()
