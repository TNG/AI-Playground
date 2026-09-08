#!/usr/bin/env node
/**
 * Load one GGUF with llama-server, sample that PID's WDDM GPU working set, compare
 * to the header estimate. Kills the server when done. Do not run while AIPG is up.
 *
 *   node --experimental-strip-types scripts/vram-measure.mts --server llama-server.exe --model x.gguf --ctx 32000
 */
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { parseGgufMetadata, type GgufReader } from '../WebUI/src/lib/vram/gguf.ts'
import { archFromMetadata } from '../WebUI/src/lib/vram/arch.ts'
import { estimateLlamaCppVram } from '../WebUI/src/lib/vram/estimate.ts'
import { bytesToMiB } from '../WebUI/src/lib/vram/units.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  return process.argv[i + 1]
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function fileReader(path: string): { reader: GgufReader; close: () => void } {
  const fd = fs.openSync(path, 'r')
  let pos = 0
  return {
    reader: {
      read(n) {
        const buf = Buffer.allocUnsafe(n)
        let got = 0
        while (got < n) {
          const read = fs.readSync(fd, buf, got, n - got, pos)
          if (read === 0) throw new Error(`Unexpected EOF in ${path}`)
          pos += read
          got += read
        }
        return buf.subarray(0, n)
      },
      skip(n) {
        pos += n
      },
    },
    close: () => fs.closeSync(fd),
  }
}

function readArch(path: string) {
  const { reader, close } = fileReader(path)
  try {
    return archFromMetadata(parseGgufMetadata(reader))
  } finally {
    close()
  }
}

function sampleProcessGpuBytes(pid: number): { dedicated: number; shared: number } {
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
  const needle = `pid_${pid}_`
  let dedicated = 0
  let shared = 0
  for (let i = 1; i < cols.length; i++) {
    if (!cols[i].includes(needle)) continue
    const n = Number(nums[i])
    if (!Number.isFinite(n)) continue
    if (cols[i].includes('Dedicated Usage')) dedicated += n
    if (cols[i].includes('Shared Usage')) shared += n
  }
  return { dedicated, shared }
}

async function waitHealth(url: string, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url)
      if (res.ok) return
    } catch {
      /* still booting */
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error(`llama-server did not become healthy at ${url}`)
}

const server = arg('server')
const modelPath = arg('model')
if (!server || !modelPath) {
  console.error('usage: --server <llama-server> --model <gguf> [--mmproj <gguf>] [--ctx N] [--mtp] [--port N]')
  process.exit(1)
}

const mmprojPath = arg('mmproj')
const contextSize = Number(arg('ctx') ?? 32000)
const port = Number(arg('port') ?? 39200)
const mtp = flag('mtp')
const extra: string[] = []
const extraIdx = process.argv.indexOf('--')
if (extraIdx >= 0) extra.push(...process.argv.slice(extraIdx + 1))

const arch = readArch(modelPath)
const estimate = estimateLlamaCppVram({
  arch,
  weightsBytes: fs.statSync(modelPath).size,
  mmprojBytes: mmprojPath ? fs.statSync(mmprojPath).size : 0,
  contextSize,
  mtp,
})

const args = [
  '--model',
  modelPath,
  '--port',
  String(port),
  '--host',
  '127.0.0.1',
  '--ctx-size',
  String(contextSize),
  '--gpu-layers',
  '999',
  '--no-mmap',
  '-fa',
  'on',
  '--jinja',
]
if (mmprojPath) args.push('--mmproj', mmprojPath)
if (mtp) args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', '6')
args.push(...extra)

const child = spawn(server, args, { stdio: ['ignore', 'pipe', 'pipe'] })
const log: string[] = []
child.stdout?.on('data', (c: Buffer) => log.push(c.toString()))
child.stderr?.on('data', (c: Buffer) => log.push(c.toString()))

const pid = child.pid
if (!pid) {
  console.error('failed to spawn llama-server')
  process.exit(1)
}

let measured: { dedicated: number; shared: number } | undefined
try {
  await waitHealth(`http://127.0.0.1:${port}/health`, 400_000)
  await new Promise((r) => setTimeout(r, 2000))
  measured = sampleProcessGpuBytes(pid)
} catch (err) {
  const tail = log.join('').slice(-4000)
  console.error(JSON.stringify({ error: String(err), logTail: tail }, null, 2))
  process.exitCode = 1
} finally {
  child.kill()
  await new Promise((r) => setTimeout(r, 1500))
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    /* already gone */
  }
}

if (!measured) process.exit(process.exitCode ?? 1)

const gpuBytes = measured.dedicated + measured.shared
const delta = gpuBytes - estimate.totalBytes
console.log(
  JSON.stringify(
    {
      label: arg('label') ?? modelPath,
      contextSize,
      mtp,
      kvPath: estimate.kvPath,
      architecture: arch.architecture,
      nextn: arch.nextnPredictLayers ?? 0,
      estimateMiB: +bytesToMiB(estimate.totalBytes).toFixed(1),
      measuredMiB: +bytesToMiB(gpuBytes).toFixed(1),
      deltaMiB: +bytesToMiB(delta).toFixed(1),
      deltaPct: +((delta / gpuBytes) * 100).toFixed(1),
      breakdownEstimateMiB: {
        weights: +bytesToMiB(estimate.weightsBytes).toFixed(1),
        kv: +bytesToMiB(estimate.kvCacheBytes).toFixed(1),
        recurrent: +bytesToMiB(estimate.recurrentStateBytes).toFixed(1),
        compute: +bytesToMiB(estimate.computeBufferBytes).toFixed(1),
        mtp: +bytesToMiB(estimate.mtpBytes).toFixed(1),
      },
      measuredBytes: measured,
    },
    null,
    2,
  ),
)
