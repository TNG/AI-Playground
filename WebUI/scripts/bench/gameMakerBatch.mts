/**
 * Game Agent overnight batch — drives the RUNNING dev app over CDP and produces
 * one agent trace per game brief, so a night of unattended runs yields data to
 * judge changes to the agentic system by (see the Laminar section of AGENTS.md).
 *
 * Usage (from WebUI/, with `npm run dev` already up and past the wizard):
 *   node --experimental-strip-types scripts/bench/gameMakerBatch.mts \
 *     [--limit 30] [--run-timeout 45] [--dry-run] [--out <dir>] [--port 29222]
 *
 * One brief is one `agentMode.generate()` call, which is one Pi `session.prompt()`
 * — the whole tool loop until the model stops asking for tools. The batch treats
 * "turn went idle" as "run complete"; what the agent actually left on disk (a real
 * name, a cover icon, design.md, an edited game.js) is recorded as a quality
 * diagnostic, not as a pass/fail gate.
 *
 * Why CDP and not Playwright: `npm run dev` already opens a remote-debugging port
 * (AIPG_DEBUGGING_PORT in package.json) and the renderer's Pinia stores are
 * directly drivable, while the Playwright harness would need a whole new set of
 * Agent Mode page objects first. Node's global WebSocket means no new dependency.
 *
 * While it runs, DO NOT edit files: saving a main-process file restarts Electron
 * and kills the in-flight session (recorded as `interrupted`).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { SCAFFOLD_FILES } from '../../electron/gameScaffold.ts'

// ── Options ──────────────────────────────────────────────────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url))

const { values } = parseArgs({
  options: {
    briefs: { type: 'string', default: path.join(HERE, 'gameBriefs.json') },
    limit: { type: 'string' },
    repeat: { type: 'string', default: '1' },
    'run-timeout': { type: 'string', default: '45' },
    out: { type: 'string' },
    port: { type: 'string', default: '29222' },
    preset: { type: 'string', default: 'Game Agent' },
    poll: { type: 'string', default: '10' },
    pause: { type: 'string', default: '20' },
    'dry-run': { type: 'boolean', default: false },
    'any-backend': { type: 'boolean', default: false },
    'skip-laminar-check': { type: 'boolean', default: false },
    // Empty string leaves the catalog alone. Default is the fast SD1.5 workflow
    // so a night of covers does not wander into a minutes-long model.
    'image-workflow': { type: 'string', default: 'Draft Image' },
  },
})

const dryRun = values['dry-run']
const options = {
  briefsFile: values.briefs!,
  limit: values.limit ? Number(values.limit) : dryRun ? 1 : Infinity,
  // One pass of the whole list runs in a few hours; repeating it fills the rest
  // of a night and, since the briefs are identical, measures run-to-run variance.
  repeat: dryRun ? 1 : Number(values.repeat),
  runTimeoutMs: Number(values['run-timeout']) * 60_000,
  port: Number(values.port),
  presetName: values.preset!,
  pollMs: Number(values.poll) * 1000,
  pauseMs: dryRun ? 0 : Number(values.pause) * 1000,
  anyBackend: values['any-backend'],
  skipLaminarCheck: values['skip-laminar-check'],
  imageWorkflow: values['image-workflow'] ?? '',
}

const outDir =
  values.out ??
  path.join(
    os.homedir(),
    'AI-Playground',
    'game-maker-batch',
    new Date().toISOString().replace(/[:.]/g, '-'),
  )

// ── Small helpers ────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function log(message: string): void {
  console.log(`[${new Date().toISOString()}] ${message}`)
}

function minutes(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`
}

/** Where Electron keeps this app's userData, matching app.getPath('userData'). */
function userDataDir(): string {
  const name = 'ai-playground'
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), name)
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', name)
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), name)
}

// ── CDP client ───────────────────────────────────────────────────────────────
//
// Every call is short: the turn is kicked off fire-and-forget in the page and
// progress is polled, so nothing here waits out the 20–40 minutes a finished run
// can take, and a dropped socket costs one run rather than the batch.

/** Thrown when the page (or the whole Electron app) went away mid-run. */
class PageLost extends Error {}

type Cdp = {
  evaluate<T>(expression: string): Promise<T>
  close(): void
}

type CdpTarget = { type: string; url: string; webSocketDebuggerUrl?: string }

/**
 * The app window is not the only page in this Electron: Game Agent's play-test
 * preview server is served into a real page too, so a run leaves a second
 * loopback target behind (`http://127.0.0.1:<port>/index.html`) that would be
 * attached to instead. Candidates are therefore probed for the mounted Vue app
 * rather than picked by URL; the dev-server port is only used to order the tries.
 */
async function candidateTargets(port: number): Promise<CdpTarget[]> {
  const response = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(5000),
  })
  const targets = (await response.json()) as CdpTarget[]
  const pages = targets.filter(
    (target) =>
      target.type === 'page' && target.url.startsWith('http') && target.webSocketDebuggerUrl,
  )
  if (pages.length === 0) throw new PageLost(`no page among ${targets.length} CDP targets`)
  return pages.sort((a, b) => Number(b.url.includes(':25413')) - Number(a.url.includes(':25413')))
}

async function attach(port: number): Promise<Cdp> {
  let lastError: unknown = null
  for (const target of await candidateTargets(port)) {
    const cdp = await openTarget(target)
    try {
      const mounted = await cdp.evaluate<boolean>(
        "!!(document.querySelector('#app') && document.querySelector('#app').__vue_app__)",
      )
      if (mounted) return cdp
    } catch (error) {
      lastError = error
    }
    cdp.close()
  }
  throw new PageLost(
    `no page on port ${port} has the app mounted${lastError ? `: ${String(lastError)}` : ''}`,
  )
}

async function openTarget(target: CdpTarget): Promise<Cdp> {
  const socket = new WebSocket(target.webSocketDebuggerUrl!)
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  let closed: Error | null = null
  let nextId = 1

  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true })
    socket.addEventListener('error', () => reject(new PageLost('CDP socket failed to open')), {
      once: true,
    })
  })

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as {
      id?: number
      result?: unknown
      error?: { message: string }
    }
    if (message.id === undefined) return
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    if (message.error) waiter.reject(new Error(`CDP error: ${message.error.message}`))
    else waiter.resolve(message.result)
  })

  socket.addEventListener('close', () => {
    closed = new PageLost('CDP socket closed (Electron restarted or window closed?)')
    for (const waiter of pending.values()) waiter.reject(closed)
    pending.clear()
  })

  return {
    async evaluate<T>(expression: string): Promise<T> {
      if (closed) throw closed
      const id = nextId++
      const result = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject })
      })
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      )
      const evaluated = (await result) as {
        result?: { value?: T }
        exceptionDetails?: { text?: string; exception?: { description?: string } }
      }
      const failure = evaluated.exceptionDetails
      if (failure) {
        throw new Error(failure.exception?.description ?? failure.text ?? 'page threw')
      }
      return evaluated.result?.value as T
    },
    close: () => socket.close(),
  }
}

// ── The page helper ──────────────────────────────────────────────────────────
//
// Injected, never shipped in the app. It reaches the stores through the mounted
// Vue app's Pinia instance and keeps the in-flight turn's promise state on
// `window.__gmBatch.run`, which is what makes `start` fire-and-forget and
// `status` cheap. A page reload wipes it, which is exactly how the batch notices
// that Electron restarted under it.

const HELPER_SOURCE = `(() => {
  const plain = (value) => {
    try { return JSON.parse(JSON.stringify(value ?? null)) } catch (_e) { return null }
  }
  const pick = (store, keys) => {
    const out = {}
    for (const key of keys) {
      if (key in store) out[key] = plain(store[key])
    }
    return out
  }
  const toolPartName = (part) => {
    if (!part || typeof part.type !== 'string') return undefined
    if (part.type === 'dynamic-tool') return part.toolName
    return part.type.startsWith('tool-') ? part.type.slice(5) : undefined
  }
  const helper = {
    store(id) {
      const app = document.querySelector('#app') && document.querySelector('#app').__vue_app__
      if (!app) throw new Error('Vue app not mounted')
      const store = app.config.globalProperties.$pinia._s.get(id)
      if (!store) throw new Error('store not instantiated: ' + id)
      return store
    },
    context() {
      const agent = this.store('agentMode')
      const inference = this.store('textInference')
      return {
        preset: agent.activeAgentPreset ? agent.activeAgentPreset.name : null,
        mode: this.store('prompt').currentMode,
        workspaceKind: agent.agentWorkspaceKind,
        workspaceDir: agent.workspaceDir,
        processing: agent.processing,
        inference: pick(inference, [
          'backend',
          'activeModel',
          'contextSize',
          'maxTokens',
          'reasoningEffort',
          'planningThinkingOnly',
          'thinkingEnabled',
          'thinking',
          'enableThinking',
        ]),
      }
    },
    async selectPreset(name) {
      const result = await this.store('presetSwitching').switchPreset(name)
      if (result && result.success === false) throw new Error(result.error || 'preset switch failed')
      return this.context()
    },
    /**
     * Restrict create-images to one workflow and make it the default, so the
     * media tool (and the specialist behind it) cannot pick a slow model. Also
     * clears the dummy-only developer override, which would hide Draft Image.
     */
    pinImageWorkflow(name) {
      const inference = this.store('textInference')
      const developer = this.store('developerSettings')
      const previousDummy = Boolean(developer.forceDummyMediaWorkflows)
      developer.forceDummyMediaWorkflows = false
      const previous = {}
      const names = []
      for (const preset of this.store('presets').presets) {
        if (preset.type !== 'comfy') continue
        if (preset.toolCategory !== 'create-images' && preset.category !== 'create-images') continue
        names.push(preset.name)
        previous[preset.name] = inference.isWorkflowPresetEnabled(preset.name)
        inference.setWorkflowPresetEnabled(preset.name, preset.name === name)
      }
      if (!names.includes(name)) {
        throw new Error('image workflow not in catalog: ' + name + ' (have ' + names.join(', ') + ')')
      }
      inference.setDefaultWorkflow('comfyUI:image', name)
      return { pinned: name, previous, previousDummy, names }
    },
    restoreImageWorkflows(previous, previousDummy) {
      const inference = this.store('textInference')
      for (const name of Object.keys(previous || {})) {
        inference.setWorkflowPresetEnabled(name, previous[name])
      }
      if (previousDummy !== undefined) {
        this.store('developerSettings').forceDummyMediaWorkflows = previousDummy
      }
      return true
    },
    async start(brief) {
      const agent = this.store('agentMode')
      // Clears the workspace so the next turn mints a fresh game folder.
      await agent.startNew()
      const run = { brief, startedAt: Date.now(), settled: false, error: null }
      this.run = run
      // Deliberately not awaited: the CDP call must return in milliseconds.
      agent.generate(brief).then(
        () => { run.settled = true },
        (error) => {
          run.settled = true
          run.error = String((error && error.message) || error)
        },
      )
      return { startedAt: run.startedAt }
    },
    status() {
      const agent = this.store('agentMode')
      const run = this.run || null
      const messages = agent.messages || []
      let toolCalls = 0
      const toolNames = []
      let assistantText = ''
      for (const message of messages) {
        for (const part of message.parts || []) {
          const tool = toolPartName(part)
          if (tool) {
            toolCalls += 1
            toolNames.push(tool)
          }
          if (part && part.type === 'text' && message.role === 'assistant') {
            assistantText = String(part.text || '')
          }
        }
      }
      const chatError = agent.chat && agent.chat.error
      return {
        hasRun: Boolean(run),
        settled: run ? run.settled : true,
        runError: run ? run.error : null,
        processing: agent.processing,
        chatStatus: agent.chat ? agent.chat.status : null,
        chatError: chatError ? String(chatError.message || chatError) : null,
        preparingBackend: this.store('textInference').isPreparingBackend,
        sessionId: agent.activeSessionId,
        workspaceDir: agent.workspaceDir,
        messageCount: messages.length,
        toolCalls: toolCalls,
        toolNames: toolNames,
        sessionUsage: plain(agent.sessionUsage),
        sessionTokens: plain(agent.sessionTokens),
        contextUsage: plain(agent.contextUsage),
        game: plain(agent.currentGame),
        lastAssistantText: assistantText.slice(-600),
      }
    },
    async stop() {
      await this.store('agentMode').stop()
      return true
    },
  }
  window.__gmBatch = helper
  return true
})()`

async function installHelper(cdp: Cdp): Promise<void> {
  await cdp.evaluate<boolean>(HELPER_SOURCE)
}

/** True when the helper is gone, i.e. the page reloaded under us. */
async function helperMissing(cdp: Cdp): Promise<boolean> {
  return (await cdp.evaluate<string>('typeof window.__gmBatch')) !== 'object'
}

// ── Session, disk and Laminar joins ──────────────────────────────────────────

type SessionPointer = { workspaceDir?: string; sessionFilePath?: string }

/**
 * The Pi session UUID for an app session id, which is what Laminar traces carry
 * as `lmnr.association.properties.session_id` — the join key from a manifest
 * line to its trace. Session files are named `<iso>_<uuid>.jsonl`.
 */
function piSessionOf(appSessionId: string | null): { file: string; id: string } | null {
  if (!appSessionId) return null
  const store = path.join(userDataDir(), 'agent-sessions.json')
  try {
    const pointers = JSON.parse(fs.readFileSync(store, 'utf-8')) as Record<string, SessionPointer>
    const file = pointers[appSessionId]?.sessionFilePath
    if (!file) return null
    const base = path.basename(file, '.jsonl')
    const uuid = base.slice(base.lastIndexOf('_') + 1)
    return { file, id: uuid }
  } catch {
    return null
  }
}

type FileState = 'missing' | 'scaffold' | 'edited'

type DiskState = {
  game: Record<string, unknown> | null
  hasDesign: boolean
  gameJs: FileState
  gameJsBytes: number
  /**
   * The page itself. Game Agent gets it from the scaffold and mostly leaves it
   * alone; a preset that starts from an empty folder writes the whole game into
   * it, and then `game.js` being 'missing' is the plan working, not a failure.
   */
  indexHtml: FileState
  indexHtmlBytes: number
  files: string[]
}

/** What the turn left in the game folder — quality diagnostics, not a verdict. */
function inspectWorkspace(workspaceDir: string): DiskState {
  const read = (name: string) => {
    try {
      return fs.readFileSync(path.join(workspaceDir, name), 'utf-8')
    } catch {
      return null
    }
  }
  const state = (name: string, contents: string | null): FileState =>
    contents === null ? 'missing' : contents === SCAFFOLD_FILES[name] ? 'scaffold' : 'edited'
  const gameJs = read('game.js')
  const indexHtml = read('index.html')
  const gameJson = read('game.json')
  let files: string[] = []
  try {
    files = fs.readdirSync(workspaceDir)
  } catch {
    files = []
  }
  return {
    game: gameJson ? (JSON.parse(gameJson) as Record<string, unknown>) : null,
    hasDesign: read('design.md') !== null,
    gameJs: state('game.js', gameJs),
    gameJsBytes: gameJs?.length ?? 0,
    indexHtml: state('index.html', indexHtml),
    indexHtmlBytes: indexHtml?.length ?? 0,
    files,
  }
}

/** Copies the artifacts worth reading in the morning next to the manifest. */
function keepArtifacts(workspaceDir: string, briefId: string): void {
  const target = path.join(outDir, 'games', `${briefId}__${path.basename(workspaceDir)}`)
  fs.mkdirSync(target, { recursive: true })
  // index.html comes along because for a one-file preset it IS the game; the
  // library folder keeps the playable copy either way.
  for (const name of ['game.json', 'design.md', 'index.html']) {
    try {
      fs.copyFileSync(path.join(workspaceDir, name), path.join(target, name))
    } catch {
      // Not written by this run — its absence is already in the manifest.
    }
  }
}

// ── Preflight ────────────────────────────────────────────────────────────────

type PageContext = {
  preset: string | null
  mode: string
  workspaceKind: string
  workspaceDir: string
  processing: boolean
  inference: Record<string, unknown>
}

async function preflight(cdp: Cdp): Promise<PageContext> {
  let context = await cdp.evaluate<PageContext>('window.__gmBatch.context()')
  if (context.preset !== options.presetName) {
    log(`switching preset ${context.preset ?? '(none)'} -> ${options.presetName}`)
    context = await cdp.evaluate<PageContext>(
      `window.__gmBatch.selectPreset(${JSON.stringify(options.presetName)})`,
    )
  }
  if (context.preset !== options.presetName) {
    throw new Error(`preset is ${context.preset}, expected ${options.presetName}`)
  }
  if (context.workspaceKind !== 'games') {
    throw new Error(
      `preset ${context.preset} does not manage its workspace (agentWorkspace=${context.workspaceKind}); ` +
        'the batch needs a games preset so every run mints its own folder',
    )
  }
  const backend = String(context.inference.backend ?? '')
  if (backend !== 'cloud' && !options.anyBackend) {
    throw new Error(`backend is ${backend || '(unset)'}; pass --any-backend to run non-cloud`)
  }
  if (context.processing) {
    throw new Error('a turn is already running in the app; let it finish first')
  }
  if (options.imageWorkflow) {
    const pin = await cdp.evaluate<{
      pinned: string
      previous: Record<string, boolean>
      previousDummy: boolean
      names: string[]
    }>(`window.__gmBatch.pinImageWorkflow(${JSON.stringify(options.imageWorkflow)})`)
    if (!imageWorkflowRestore) {
      imageWorkflowRestore = { previous: pin.previous, previousDummy: pin.previousDummy }
    }
    log(
      `image workflow pinned to "${pin.pinned}" (${pin.names.length} create-images presets, ` +
        `dummy-only was ${pin.previousDummy})`,
    )
  }

  const laminarConfig = path.join(HERE, '..', '..', 'external', 'laminar.dev.json')
  if (fs.existsSync(laminarConfig)) {
    const config = JSON.parse(fs.readFileSync(laminarConfig, 'utf-8')) as {
      baseUrl?: string
      httpPort?: number
    }
    const ingest = `${config.baseUrl ?? 'http://localhost'}:${config.httpPort ?? 8000}`
    // Any answer proves something is listening; the endpoint 404s on GET.
    await fetch(ingest, { signal: AbortSignal.timeout(3000) }).then(
      () => log(`laminar ingest reachable at ${ingest}`),
      () => log(`WARNING: laminar ingest ${ingest} did not answer — traces may be lost`),
    )
  } else if (!options.skipLaminarCheck) {
    throw new Error(
      `${laminarConfig} is missing, so nothing is traced; ` +
        'copy external/laminar.dev.example.json or pass --skip-laminar-check',
    )
  }

  log(
    `ready: preset=${context.preset} backend=${backend} model=${String(
      context.inference.activeModel ?? '?',
    )} context=${String(context.inference.contextSize ?? '?')}`,
  )
  return context
}

// ── The batch ────────────────────────────────────────────────────────────────

type Status = {
  hasRun: boolean
  settled: boolean
  runError: string | null
  processing: boolean
  chatStatus: string | null
  chatError: string | null
  preparingBackend: boolean
  sessionId: string | null
  workspaceDir: string
  messageCount: number
  toolCalls: number
  toolNames: string[]
  sessionUsage: unknown
  sessionTokens: unknown
  contextUsage: unknown
  game: Record<string, unknown> | null
  lastAssistantText: string
}

type Outcome = 'done' | 'error' | 'timeout' | 'interrupted'

type RunRecord = {
  briefId: string
  brief: string
  /** 1-based pass over the brief list, so `--repeat` runs stay distinguishable. */
  pass: number
  outcome: Outcome
  startedAt: string
  endedAt: string
  durationMs: number
  error: string | null
  appSessionId: string | null
  piSessionId: string | null
  piSessionFile: string | null
  workspaceDir: string
  messageCount: number
  toolCalls: number
  toolNames: string[]
  sessionUsage: unknown
  sessionTokens: unknown
  contextUsage: unknown
  disk: DiskState | null
  lastAssistantText: string
}

let cdp: Cdp
/** Set by SIGINT: finish the current poll, settle the run, write the summary. */
let stopping = false
/** Enablement snapshot from the first pin, restored when the batch exits. */
let imageWorkflowRestore: { previous: Record<string, boolean>; previousDummy: boolean } | null =
  null

async function restoreImageWorkflows(): Promise<void> {
  if (!imageWorkflowRestore || !options.imageWorkflow) return
  try {
    if (await helperMissing(cdp)) await installHelper(cdp)
    await cdp.evaluate(
      `window.__gmBatch.restoreImageWorkflows(${JSON.stringify(imageWorkflowRestore.previous)}, ${JSON.stringify(imageWorkflowRestore.previousDummy)})`,
    )
    log(`restored create-images enablement (dummy-only=${imageWorkflowRestore.previousDummy})`)
  } catch (error) {
    log(`WARNING: could not restore image workflows: ${String(error)}`)
  }
}

/**
 * Reattach after Electron restarted (an HMR restart of a main-process file, or a
 * crash): the port comes back within seconds, but the page is fresh, so the
 * helper is reinstalled and the preset re-asserted.
 */
async function reattach(): Promise<void> {
  const deadline = Date.now() + 5 * 60_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      cdp = await attach(options.port)
      await installHelper(cdp)
      await preflight(cdp)
      log('reattached to a fresh renderer')
      return
    } catch (error) {
      lastError = error
      await sleep(5000)
    }
  }
  throw new Error(`could not reattach on port ${options.port}: ${String(lastError)}`)
}

/** A status poll that survives the page going away, at the cost of the run. */
async function pollStatus(): Promise<Status | 'lost'> {
  try {
    if (await helperMissing(cdp)) {
      await installHelper(cdp)
      await preflight(cdp)
      return 'lost'
    }
    return await cdp.evaluate<Status>('window.__gmBatch.status()')
  } catch (error) {
    if (!(error instanceof PageLost)) throw error
    await reattach()
    return 'lost'
  }
}

function briefWithImageHint(brief: string): string {
  if (!options.imageWorkflow) return brief
  return `${brief} For every image (cover and sprites), use only the "${options.imageWorkflow}" workflow.`
}

async function runBrief(briefId: string, brief: string, pass: number): Promise<RunRecord> {
  const startedAt = Date.now()
  const prompt = briefWithImageHint(brief)
  log(`▶ ${briefId}: ${prompt}`)
  try {
    if (await helperMissing(cdp)) {
      await installHelper(cdp)
      await preflight(cdp)
    }
  } catch (error) {
    if (!(error instanceof PageLost)) throw error
    await reattach()
  }
  await cdp.evaluate<{ startedAt: number }>(`window.__gmBatch.start(${JSON.stringify(prompt)})`)

  const deadline = startedAt + options.runTimeoutMs
  let last: Status | null = null
  let outcome: Outcome = 'interrupted'
  let error: string | null = null
  let printedAt = 0
  let printedProgress = ''

  for (;;) {
    await sleep(options.pollMs)
    const status = await pollStatus()
    if (status === 'lost') {
      outcome = 'interrupted'
      error = 'Electron restarted or the page reloaded mid-run'
      break
    }
    last = status
    const progress = `${status.messageCount} msgs / ${status.toolCalls} tools [${status.chatStatus}]`
    if (progress !== printedProgress || Date.now() - printedAt > 120_000 || dryRun) {
      printedProgress = progress
      printedAt = Date.now()
      log(`  ${briefId} ${minutes(Date.now() - startedAt)} ${progress}`)
      if (dryRun && status.toolNames.length) log(`  tools: ${status.toolNames.join(', ')}`)
    }
    if (status.runError) {
      outcome = 'error'
      error = status.runError
      break
    }
    if (status.settled && !status.processing) {
      outcome = status.chatError ? 'error' : 'done'
      error = status.chatError
      break
    }
    if (Date.now() > deadline) {
      log(`  ${briefId} hit the ${minutes(options.runTimeoutMs)} cap — stopping the turn`)
      await cdp.evaluate('window.__gmBatch.stop()').catch(() => {})
      outcome = 'timeout'
      break
    }
    if (stopping) {
      log(`  ${briefId} interrupted by SIGINT — stopping the turn`)
      await cdp.evaluate('window.__gmBatch.stop()').catch(() => {})
      outcome = 'interrupted'
      error = 'aborted by SIGINT'
      break
    }
  }

  const workspaceDir = last?.workspaceDir ?? ''
  const disk = workspaceDir ? inspectWorkspace(workspaceDir) : null
  if (workspaceDir) keepArtifacts(workspaceDir, briefId)
  const pi = piSessionOf(last?.sessionId ?? null)

  const record: RunRecord = {
    briefId,
    brief,
    pass,
    outcome,
    startedAt: new Date(startedAt).toISOString(),
    endedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    error,
    appSessionId: last?.sessionId ?? null,
    piSessionId: pi?.id ?? null,
    piSessionFile: pi?.file ?? null,
    workspaceDir,
    messageCount: last?.messageCount ?? 0,
    toolCalls: last?.toolCalls ?? 0,
    toolNames: last?.toolNames ?? [],
    sessionUsage: last?.sessionUsage ?? null,
    sessionTokens: last?.sessionTokens ?? null,
    contextUsage: last?.contextUsage ?? null,
    disk,
    lastAssistantText: last?.lastAssistantText ?? '',
  }
  log(
    `■ ${briefId} ${outcome} in ${minutes(record.durationMs)} — ` +
      `${record.toolCalls} tools, name="${String(disk?.game?.name ?? '?')}", ` +
      `icon=${disk?.game?.icon ? 'yes' : 'no'}, design=${disk?.hasDesign ? 'yes' : 'no'}, ` +
      `game.js=${disk?.gameJs ?? '?'}, index.html=${disk?.indexHtml ?? '?'}, ` +
      `trace session=${record.piSessionId ?? '?'}` +
      (error ? ` — ${error}` : ''),
  )
  return record
}

// ── Summary ──────────────────────────────────────────────────────────────────

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

function summarize(records: RunRecord[]): Record<string, unknown> {
  const byOutcome: Record<string, number> = {}
  for (const record of records) byOutcome[record.outcome] = (byOutcome[record.outcome] ?? 0) + 1
  const done = records.filter((record) => record.outcome === 'done')
  const summary = {
    runs: records.length,
    byOutcome,
    doneWithIcon: done.filter((record) => record.disk?.game?.icon).length,
    doneWithDesign: done.filter((record) => record.disk?.hasDesign).length,
    doneWithEditedGameJs: done.filter((record) => record.disk?.gameJs === 'edited').length,
    // The preset-agnostic version of the same question: did the run leave a page
    // that is not the one it started with?
    doneWithWrittenPage: done.filter(
      (record) => record.disk?.indexHtml === 'edited' || record.disk?.gameJs === 'edited',
    ).length,
    medianDurationMs: median(done.map((record) => record.durationMs)),
    medianToolCalls: median(done.map((record) => record.toolCalls)),
    traceSessionIds: records.map((record) => record.piSessionId).filter(Boolean),
  }
  console.log('\n── batch summary ──')
  console.log(JSON.stringify(summary, null, 2))
  console.log(`\nmanifest: ${path.join(outDir, 'manifest.jsonl')}`)
  return summary
}

// ── Main ─────────────────────────────────────────────────────────────────────

type Brief = { id: string; brief: string }

const briefs = (
  JSON.parse(fs.readFileSync(options.briefsFile, 'utf-8')) as { briefs: Brief[] }
).briefs.slice(0, options.limit)

const runs = Array.from({ length: options.repeat }, (_unused, pass) =>
  briefs.map((brief) => ({ ...brief, pass: pass + 1 })),
).flat()

fs.mkdirSync(outDir, { recursive: true })
const manifestPath = path.join(outDir, 'manifest.jsonl')
const records: RunRecord[] = []

process.on('SIGINT', () => {
  if (stopping) process.exit(130)
  stopping = true
  log('SIGINT: finishing the current poll, then writing the summary (again to force)')
})

log(`batch of ${runs.length} run(s) (${briefs.length} brief(s) x ${options.repeat}), out=${outDir}`)
try {
  cdp = await attach(options.port)
} catch (error) {
  console.error(
    `Cannot reach the app's debugging port ${options.port}: ${String(error)}\n` +
      'Start the dev app first (cd WebUI && npm run dev) and let it get past the setup wizard.',
  )
  process.exit(1)
}
try {
  await installHelper(cdp)
  await preflight(cdp)

  let consecutiveErrors = 0
  for (const [index, brief] of runs.entries()) {
    if (stopping) break
    log(`── run ${index + 1}/${runs.length} (pass ${brief.pass}) ──`)
    const record = await runBrief(brief.id, brief.brief, brief.pass)
    records.push(record)
    fs.appendFileSync(manifestPath, `${JSON.stringify(record)}\n`)

    // A temporary cloud key that has expired would otherwise fail every brief in
    // seconds and waste the night, so a run of failures ends the batch.
    consecutiveErrors = record.outcome === 'error' ? consecutiveErrors + 1 : 0
    if (consecutiveErrors >= 3) {
      log('3 consecutive failures — aborting the batch (expired key? backend down?)')
      break
    }
    if (index < runs.length - 1 && !stopping) await sleep(options.pauseMs)
  }

  const summary = summarize(records)
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
} finally {
  await restoreImageWorkflows()
  cdp.close()
}
