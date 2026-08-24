/**
 * Driving one llama-server at a time on the Windows test box.
 *
 * Each arm of the sweep needs its own server process: speculative decoding is a
 * startup flag, not a request parameter. So the benchmark starts a server over
 * SSH, waits for it through a port-forward, sends its requests, kills it and
 * takes the log with it.
 *
 * Arguments travel as a JSON file rather than a command line: the shell → SSH →
 * PowerShell chain mangles quoted arguments (the reasoning-budget message has
 * spaces in it), and a file has no quoting at all.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export type RemoteConfig = {
  host: string
  exe: string
  model: string
  mmproj?: string
  port: number
  ctxSize: number
  /** Windows directory for the helper script, arg files and per-arm logs. */
  workDir: string
}

export type StartedServer = {
  pid: number
  /** Windows path of the server's combined log. */
  log: string
}

const HELPER_NAME = 'spec-bench-server.ps1'

/**
 * The remote half.
 *
 * The server is created through `Win32_Process`, not `Start-Process`: a child of
 * an SSH session belongs to that session's job object and is killed when the
 * command returns, which showed up as a server that reached "loading model" and
 * then vanished. `Win32_Process.Create` hands the process to the service control
 * manager instead, so it outlives the SSH call that asked for it.
 *
 * That call reports the pid of the `cmd.exe` wrapper doing the redirection, so
 * the real one is looked up by the port in its command line.
 */
const HELPER_SCRIPT = `param(
  [Parameter(Mandatory=$true)][string]$Action,
  [string]$ArgsFile,
  [int]$ServerPid
)
$ErrorActionPreference = 'Stop'

function Find-Server([int]$Port) {
  Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" |
    Where-Object { $_.CommandLine -like "*--port $Port *" -or $_.CommandLine -like "*--port $Port" } |
    Select-Object -First 1 -ExpandProperty ProcessId
}

if ($Action -eq 'start') {
  $cfg = Get-Content -Raw -Path $ArgsFile | ConvertFrom-Json
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cfg.log) | Out-Null
  if (Test-Path $cfg.log) { Remove-Item $cfg.log -Force }
  $quoted = @($cfg.serverArgs | ForEach-Object {
    if ($_ -match '\\s') { '"' + $_ + '"' } else { $_ }
  })
  # Working directory matters: ggml loads its backend DLLs (Vulkan, BLAS) at
  # runtime and finds them next to the executable, not next to the SSH session.
  $line = 'cmd.exe /c ""' + $cfg.exe + '" ' + ($quoted -join ' ') + ' > "' + $cfg.log + '" 2>&1"'
  $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = $line
    CurrentDirectory = (Split-Path -Parent $cfg.exe)
  }
  if ($created.ReturnValue -ne 0) { throw "Win32_Process.Create failed: $($created.ReturnValue)" }
  # A server that dies on its arguments should say so now rather than time out
  # fifteen minutes later in the health poll.
  $found = $null
  foreach ($attempt in 1..20) {
    Start-Sleep -Milliseconds 500
    $found = Find-Server $cfg.port
    if ($found) { break }
  }
  if (-not $found) { throw "llama-server never appeared; log: $(Get-Content $cfg.log -Tail 5 -ErrorAction SilentlyContinue)" }
  $found
}
elseif ($Action -eq 'stop') {
  Stop-Process -Id $ServerPid -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  'stopped'
}
elseif ($Action -eq 'ps') {
  $running = @(Get-Process llama-server -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
  if ($running.Count -eq 0) { 'none' } else { $running -join ',' }
}
else { throw "unknown action $Action" }
`

function run(command: string, args: string[], timeoutMs = 120_000): string {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: timeoutMs })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited ${result.status}: ${result.stderr || result.stdout}`,
    )
  }
  return result.stdout.trim()
}

function ssh(config: RemoteConfig, command: string, timeoutMs?: number): string {
  return run('ssh', ['-o', 'BatchMode=yes', config.host, command], timeoutMs)
}

function powershell(config: RemoteConfig, args: string[]): string {
  const helper = `${config.workDir}\\${HELPER_NAME}`
  return ssh(
    config,
    ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, ...args].join(' '),
  )
}

/** Copy the helper script over once per sweep. */
export function installHelper(config: RemoteConfig): void {
  const local = path.join(os.tmpdir(), HELPER_NAME)
  fs.writeFileSync(local, HELPER_SCRIPT)
  ssh(
    config,
    `powershell -NoProfile -Command "New-Item -ItemType Directory -Force -Path '${config.workDir}' | Out-Null"`,
  )
  run('scp', ['-q', local, `${config.host}:${config.workDir.replace(/\\/g, '/')}/${HELPER_NAME}`])
}

/** Process ids of any llama-server already holding the GPU. */
export function runningServers(config: RemoteConfig): number[] {
  const output = powershell(config, ['-Action', 'ps'])
  if (output === 'none' || output === '') return []
  return output
    .split(',')
    .map((entry) => Number(entry.trim()))
    .filter((pid) => Number.isFinite(pid))
}

export function startServer(
  config: RemoteConfig,
  armId: string,
  specFlags: string[],
  commonFlags: string[],
): StartedServer {
  const log = `${config.workDir}\\${armId}.log`
  const serverArgs = [
    '--model',
    config.model,
    '--port',
    String(config.port),
    '--ctx-size',
    String(config.ctxSize),
    ...(config.mmproj ? ['--mmproj', config.mmproj] : []),
    ...specFlags,
    ...commonFlags,
    '--host',
    '127.0.0.1',
  ]
  const argsFileLocal = path.join(os.tmpdir(), `spec-bench-${armId}.json`)
  fs.writeFileSync(
    argsFileLocal,
    JSON.stringify({ exe: config.exe, log, port: config.port, serverArgs }, null, 2),
  )
  const remoteArgsFile = `${config.workDir}\\${armId}.json`
  run('scp', [
    '-q',
    argsFileLocal,
    `${config.host}:${config.workDir.replace(/\\/g, '/')}/${armId}.json`,
  ])
  const pid = Number(powershell(config, ['-Action', 'start', '-ArgsFile', remoteArgsFile]))
  if (!Number.isFinite(pid)) throw new Error(`server for arm ${armId} reported no pid`)
  return { pid, log }
}

/**
 * Stop the arm and wait for its memory to come back.
 *
 * The next arm's server asks the driver how much device memory is free before
 * it allocates, and aborts if the answer is too small. A 16.7 GB model does not
 * disappear the instant the process is killed, so a start that follows a stop
 * too closely dies with "failed to fit params to free device memory" — and then
 * sits there holding what it did allocate.
 */
export function stopServer(config: RemoteConfig, pid: number, settleMs = 20_000): void {
  powershell(config, ['-Action', 'stop', '-ServerPid', String(pid)])
  const deadline = Date.now() + settleMs
  while (Date.now() < deadline) {
    if (runningServers(config).length === 0) break
    spawnSync('sleep', ['2'])
  }
  spawnSync('sleep', ['10'])
}

/** Bring the arm's log home; the wrapper merges llama.cpp's stderr into it. */
export function fetchLog(config: RemoteConfig, server: StartedServer, destination: string): string {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  try {
    run('scp', ['-q', `${config.host}:${server.log.replace(/\\/g, '/')}`, destination])
  } catch {
    // A server that died before writing has nothing to fetch; the arm's request
    // errors say more than a missing file would.
    fs.writeFileSync(destination, '')
  }
  return fs.readFileSync(destination, 'utf8')
}

export type TunnelHandle = { close: () => void }

/**
 * One port-forward for the whole sweep. Servers come and go behind it; a
 * forward to a dead port just refuses connections, which is what the health
 * poll expects while a model loads.
 *
 * An arm runs for the better part of an hour, and a forward that idles through
 * a long prefill can be dropped by the network. Losing it looks exactly like a
 * dead server from this side, so the forward keeps itself alive and is
 * respawned if it dies anyway — the arm behind it is still perfectly healthy.
 */
export function openTunnel(config: RemoteConfig): TunnelHandle {
  let closed = false
  let child: ChildProcess | undefined

  const spawnOnce = (): void => {
    if (closed) return
    child = spawn(
      'ssh',
      [
        '-o',
        'BatchMode=yes',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'ServerAliveInterval=15',
        '-o',
        'ServerAliveCountMax=4',
        '-o',
        'TCPKeepAlive=yes',
        '-N',
        '-L',
        `${config.port}:127.0.0.1:${config.port}`,
        config.host,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    child.on('exit', () => {
      if (closed) return
      console.log('   (port-forward dropped, reconnecting)')
      setTimeout(spawnOnce, 2000)
    })
  }

  spawnOnce()
  return {
    close: () => {
      closed = true
      child?.kill()
    },
  }
}

/** Load failures llama.cpp reports and then does not exit on. */
const FATAL_LOG = /failed to fit params|error loading model|failed to load model|out of memory/i

export async function waitForHealth(
  baseUrl: string,
  timeoutMs: number,
  onCheck?: () => string | null,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let lastError = 'never answered'
  let polls = 0
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) })
      if (response.ok) return
      lastError = `HTTP ${response.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    // A server can give up on its arguments, say so in the log and then keep the
    // process (and its allocation) alive. Only the log tells us, so it is read
    // every ~16s while we wait.
    polls += 1
    if (onCheck && polls % 8 === 0) {
      const complaint = onCheck()
      if (complaint) throw new Error(`server failed to start: ${complaint}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 2000))
  }
  throw new Error(
    `server did not become healthy within ${Math.round(timeoutMs / 1000)}s: ${lastError}`,
  )
}

/** The last fatal line of a starting server's log, if it has written one. */
export function fatalInLog(config: RemoteConfig, server: StartedServer): string | null {
  let tail = ''
  try {
    tail = ssh(
      config,
      `powershell -NoProfile -Command "Get-Content '${server.log}' -Tail 25 -ErrorAction SilentlyContinue"`,
      30_000,
    )
  } catch {
    return null
  }
  const fatal = tail.split(/\r?\n/).find((line) => FATAL_LOG.test(line))
  return fatal ? fatal.trim() : null
}

// ── Log statistics ──────────────────────────────────────────────────────────
//
// llama.cpp prints what its drafting actually did, which is the only way to
// tell a speculative implementation that fired from one that was silently
// ignored (a request's timings look the same either way).

export type DraftStats = {
  /** Accepted / generated across the arm's requests, as the server counted it. */
  acceptanceRate: number | null
  accepted: number
  generated: number
  /** One line per implementation that reported: `draft`, `ngram_mod`, … */
  implementations: Record<string, { generatedTokens: number; acceptedTokens: number }>
  /** Raw statistics lines, kept because their fields differ per implementation. */
  lines: string[]
}

export function parseDraftStats(log: string): DraftStats {
  const implementations: Record<string, { generatedTokens: number; acceptedTokens: number }> = {}
  const lines: string[] = []
  let accepted = 0
  let generated = 0

  for (const line of log.split(/\r?\n/)) {
    const rate =
      /draft acceptance rate = [\d.]+\s*\(\s*(\d+) accepted\s*\/\s*(\d+) generated\)/.exec(line)
    if (rate) {
      accepted += Number(rate[1])
      generated += Number(rate[2])
      lines.push(line.trim())
      continue
    }
    const stats = /statistics ([a-z0-9_]+):(.*)$/i.exec(line)
    if (!stats) continue
    lines.push(line.trim())
    const name = stats[1]
    const body = stats[2]
    const gen = /#gen tokens = (\d+)/.exec(body)
    const acc = /#acc tokens = (\d+)/.exec(body)
    const entry = implementations[name] ?? { generatedTokens: 0, acceptedTokens: 0 }
    entry.generatedTokens += gen ? Number(gen[1]) : 0
    entry.acceptedTokens += acc ? Number(acc[1]) : 0
    implementations[name] = entry
  }

  return {
    acceptanceRate: generated > 0 ? accepted / generated : null,
    accepted,
    generated,
    implementations,
    lines,
  }
}
