#!/usr/bin/env node
/**
 * Spawn a sidecar, wait until it is healthy, optionally run one request, and
 * sample that PID tree's WDDM GPU working set. Do not run while AIPG is up.
 *
 *   node --experimental-strip-types scripts/vram-measure-process.mts \
 *     --label embed-bge --health http://127.0.0.1:39200/health -- \
 *     llama-server.exe --embedding --model x.gguf --port 39200
 */
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { bytesToMiB } from '../WebUI/src/lib/vram/units.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  return process.argv[i + 1]
}

function parseAfterDash(): string[] {
  const i = process.argv.indexOf('--')
  return i >= 0 ? process.argv.slice(i + 1) : []
}

function processTreePids(root: number): number[] {
  const found = new Set<number>([root])
  const queue = [root]
  while (queue.length) {
    const id = queue.pop()
    if (id === undefined) break
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${id}" -ErrorAction SilentlyContinue | Select-Object -ExpandProperty ProcessId`,
      ],
      { encoding: 'utf8', timeout: 15_000 },
    )
    for (const line of out.split(/\r?\n/)) {
      const n = Number(line.trim())
      if (Number.isInteger(n) && n > 0 && !found.has(n)) {
        found.add(n)
        queue.push(n)
      }
    }
  }
  return [...found]
}

function sampleProcessGpuBytes(pids: number[]): { dedicated: number; shared: number } {
  const csv = execFileSync(
    'typeperf',
    [
      String.raw`\GPU Process Memory(*)\Dedicated Usage`,
      String.raw`\GPU Process Memory(*)\Shared Usage`,
      '-sc',
      '1',
    ],
    { encoding: 'utf8', timeout: 20_000 },
  )
  const lines = csv.split(/\r?\n/).filter((l) => l.startsWith('"'))
  const header = lines[0]
  const values = lines[1]
  if (!header || !values) throw new Error('typeperf returned no CSV rows')
  const cols = header.split('","').map((s) => s.replace(/^"|"$/g, ''))
  const nums = values.split('","').map((s) => s.replace(/^"|"$/g, ''))
  const needles = pids.map((p) => `pid_${p}_`)
  let dedicated = 0
  let shared = 0
  for (let i = 1; i < cols.length; i++) {
    if (!needles.some((n) => cols[i].includes(n))) continue
    const n = Number(nums[i])
    if (!Number.isFinite(n)) continue
    if (cols[i].includes('Dedicated Usage')) dedicated += n
    if (cols[i].includes('Shared Usage')) shared += n
  }
  return { dedicated, shared }
}

function sampleTree(root: number): { pids: number[]; dedicated: number; shared: number; gpu: number } {
  const pids = processTreePids(root)
  const mem = sampleProcessGpuBytes(pids)
  return { pids, ...mem, gpu: mem.dedicated + mem.shared }
}

function applySetEnvs(): void {
  for (let i = 0; i < process.argv.length - 1; i++) {
    if (process.argv[i] !== '--set-env') continue
    const raw = process.argv[i + 1]
    const eq = raw.indexOf('=')
    if (eq <= 0) continue
    process.env[raw.slice(0, eq)] = raw.slice(eq + 1)
  }
}

function parseHeader(raw: string | undefined): Record<string, string> {
  if (!raw) return {}
  const [k, ...rest] = raw.split(':')
  if (!k) return {}
  return { [k.trim()]: rest.join(':').trim() }
}

async function waitHealth(
  url: string,
  timeoutMs: number,
  headers: Record<string, string>,
): Promise<void> {
  const start = Date.now()
  let last = ''
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { headers })
      if (res.ok) return
      last = `${res.status}`
    } catch (err) {
      last = String(err)
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`not healthy at ${url} (${last})`)
}

type WorkflowNode = { inputs: Record<string, unknown>; class_type: string }
type Workflow = Record<string, WorkflowNode>
type SweepRun = { label: string } & Record<string, string | number>
type Sweep = {
  template: string
  patch: Record<string, [string, string]>
  runs: SweepRun[]
}

function applySweepPatch(template: Workflow, patch: Sweep['patch'], run: SweepRun): Workflow {
  const wf = JSON.parse(JSON.stringify(template)) as Workflow
  for (const [key, loc] of Object.entries(patch)) {
    const val = run[key]
    if (val === undefined) continue
    const [node, field] = loc
    const target = wf[node]
    if (!target) throw new Error(`sweep patch missing node ${node}`)
    target.inputs[field] = val
  }
  return wf
}

async function runComfyWorkflow(
  base: string,
  prompt: unknown,
  headers: Record<string, string>,
  timeoutMs = 900_000,
): Promise<void> {
  const queued = await fetch(`${base}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ prompt }),
  })
  const body = (await queued.json()) as { prompt_id?: string; error?: unknown }
  if (!queued.ok || !body.prompt_id) {
    throw new Error(`comfy /prompt failed: ${JSON.stringify(body)}`)
  }
  const id = body.prompt_id
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    await new Promise((r) => setTimeout(r, 2000))
    const histRes = await fetch(`${base}/history/${id}`, { headers })
    const hist = (await histRes.json()) as Record<
      string,
      { outputs?: object; status?: { completed?: boolean; status_str?: string } }
    >
    const entry = hist[id]
    if (entry?.status?.status_str === 'error') {
      throw new Error(`comfy workflow error: ${JSON.stringify(entry)}`)
    }
    if (entry?.status?.completed || (entry?.outputs && Object.keys(entry.outputs).length > 0)) {
      return
    }
  }
  throw new Error(`comfy workflow ${id} did not finish`)
}

async function comfyFreeCache(
  base: string,
  headers: Record<string, string>,
): Promise<void> {
  const res = await fetch(`${base}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ free_memory: true, unload_models: false }),
  })
  if (!res.ok) throw new Error(`comfy /free failed: ${res.status}`)
  await new Promise((r) => setTimeout(r, 5000))
}

applySetEnvs()

const cmd = parseAfterDash()
const health = arg('health')
if (cmd.length === 0 || !health) {
  console.error('usage: --label NAME --health URL [--cwd DIR] [--probe-url URL] [--comfy-workflow FILE] -- <cmd>')
  process.exit(1)
}

const cwd = arg('cwd') ?? process.cwd()
const label = arg('label') ?? cmd[0]
const probeUrl = arg('probe-url')
const probeBody = arg('probe-body')
const probeHeader = arg('probe-header')
const authHeaders = parseHeader(arg('auth-header'))
const comfyWorkflow = arg('comfy-workflow')
const sweepPath = arg('sweep')
const timeoutMs = Number(arg('timeout-ms') ?? 400_000)
const workflowTimeoutMs = Number(arg('workflow-timeout-ms') ?? 900_000)

const child = spawn(cmd[0], cmd.slice(1), {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: process.env,
  windowsHide: true,
})
const log: string[] = []
child.stdout?.on('data', (c: Buffer) => log.push(c.toString()))
child.stderr?.on('data', (c: Buffer) => log.push(c.toString()))
const pid = child.pid
if (!pid) {
  console.error('failed to spawn')
  process.exit(1)
}

let idle: ReturnType<typeof sampleTree> | undefined
let peakGpu = 0
let peakSample: ReturnType<typeof sampleTree> | undefined
type RunResult = { label: string; restMiB: number; peakMiB: number; deltaMiB: number; error?: string }
const sweepRuns: RunResult[] = []

try {
  await waitHealth(health, timeoutMs, authHeaders)
  await new Promise((r) => setTimeout(r, 2000))
  idle = sampleTree(pid)
  peakGpu = idle.gpu
  peakSample = idle

  if (probeUrl) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (probeHeader) {
      const [k, ...rest] = probeHeader.split(':')
      headers[k.trim()] = rest.join(':').trim()
    }
    const res = await fetch(probeUrl, {
      method: 'POST',
      headers,
      body: probeBody ?? '{}',
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`probe ${res.status}: ${text.slice(0, 500)}`)
    }
    await new Promise((r) => setTimeout(r, 1000))
    const after = sampleTree(pid)
    if (after.gpu > peakGpu) {
      peakGpu = after.gpu
      peakSample = after
    }
  }

  const workflows: { label: string; prompt: unknown }[] = []
  if (sweepPath) {
    const sweepDir = sweepPath.replace(/[^/\\]+$/, '')
    const sweep = JSON.parse(fs.readFileSync(sweepPath, 'utf8')) as Sweep
    const template = JSON.parse(fs.readFileSync(`${sweepDir}${sweep.template}`, 'utf8')) as Workflow
    for (const run of sweep.runs) {
      workflows.push({ label: run.label, prompt: applySweepPatch(template, sweep.patch, run) })
    }
  } else if (comfyWorkflow) {
    workflows.push({
      label,
      prompt: JSON.parse(fs.readFileSync(comfyWorkflow, 'utf8')) as unknown,
    })
  }

  if (workflows.length) {
    const base = health.replace(/\/[^/]+$/, '')
    for (const wf of workflows) {
      await new Promise((r) => setTimeout(r, 2000))
      const rest = sampleTree(pid)
      const restGpu = rest.gpu
      let runPeak = restGpu
      const timer = setInterval(() => {
        try {
          const now = sampleTree(pid)
          if (now.gpu > runPeak) {
            runPeak = now.gpu
            peakSample = now
            if (now.gpu > peakGpu) peakGpu = now.gpu
          }
        } catch {
          /* typeperf flake */
        }
      }, 3000)
      try {
        console.error(`----- ${wf.label} -----`)
        await runComfyWorkflow(base, wf.prompt, authHeaders, workflowTimeoutMs)
        const after = sampleTree(pid)
        if (after.gpu > runPeak) runPeak = after.gpu
        if (runPeak > peakGpu) peakGpu = runPeak
        sweepRuns.push({
          label: wf.label,
          restMiB: +bytesToMiB(restGpu).toFixed(1),
          peakMiB: +bytesToMiB(runPeak).toFixed(1),
          deltaMiB: +bytesToMiB(runPeak - restGpu).toFixed(1),
        })
      } catch (err) {
        sweepRuns.push({
          label: wf.label,
          restMiB: +bytesToMiB(restGpu).toFixed(1),
          peakMiB: +bytesToMiB(runPeak).toFixed(1),
          deltaMiB: +bytesToMiB(Math.max(0, runPeak - restGpu)).toFixed(1),
          error: String(err),
        })
        console.error(JSON.stringify({ run: wf.label, error: String(err), logTail: log.join('').slice(-2000) }))
      } finally {
        clearInterval(timer)
        try {
          await comfyFreeCache(base, authHeaders)
        } catch (err) {
          console.error(`----- ${wf.label} /free failed: ${String(err)} -----`)
        }
      }
    }
  }
} catch (err) {
  console.error(JSON.stringify({ error: String(err), logTail: log.join('').slice(-4000) }, null, 2))
  process.exitCode = 1
} finally {
  try {
    child.stdout?.destroy()
    child.stderr?.destroy()
  } catch {
    /* ignore */
  }
  child.kill()
  await new Promise((r) => setTimeout(r, 1500))
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* already gone */
  }
}

if (!idle || !peakSample) process.exit(process.exitCode ?? 1)

console.log(
  JSON.stringify(
    {
      label,
      idleMiB: +bytesToMiB(idle.gpu).toFixed(1),
      peakMiB: +bytesToMiB(peakGpu).toFixed(1),
      idle: {
        dedicatedMiB: +bytesToMiB(idle.dedicated).toFixed(1),
        sharedMiB: +bytesToMiB(idle.shared).toFixed(1),
        pids: idle.pids,
      },
      peak: {
        dedicatedMiB: +bytesToMiB(peakSample.dedicated).toFixed(1),
        sharedMiB: +bytesToMiB(peakSample.shared).toFixed(1),
        pids: peakSample.pids,
      },
      runs: sweepRuns,
    },
    null,
    2,
  ),
)
process.exit(process.exitCode ?? 0)
