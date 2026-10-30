import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export type RegistryValueChange =
  | { action: 'set'; name: string; type: 'REG_DWORD'; data: number }
  | { action: 'set'; name: string; type: 'REG_SZ'; data: string }
  | { action: 'delete'; name: string }

export type ElevatedRunResult = { ok: true } | { ok: false; cancelled: boolean; error: string }

export type ElevatedRegistryRunner = (changes: RegistryValueChange[]) => Promise<ElevatedRunResult>

const ERROR_CANCELLED = 1223
const SAFE_KEY = /^HKLM\\[A-Za-z0-9 \\]+$/
const SAFE_NAME = /^[A-Za-z0-9]+$/
const SAFE_STRING = /^[A-Za-z0-9+/=$.]*$/

function literal(value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw new Error(`Refusing unsafe registry argument: ${value}`)
  return `'${value}'`
}

/** The PowerShell script the elevated process runs; stops at the first failing write. */
export function buildRegistryScript(key: string, changes: RegistryValueChange[]): string {
  const k = literal(key, SAFE_KEY)
  const fail = 'if ($LASTEXITCODE -ne 0) { exit 1 }'
  const lines = changes.map((change) => {
    const name = literal(change.name, SAFE_NAME)
    if (change.action === 'delete') {
      return (
        `& reg.exe query ${k} /v ${name} /reg:64 *> $null; ` +
        `if ($LASTEXITCODE -eq 0) { & reg.exe delete ${k} /v ${name} /f /reg:64 | Out-Null; ${fail} }`
      )
    }
    let data: string
    if (change.type === 'REG_DWORD') {
      if (!Number.isInteger(change.data) || change.data < 0 || change.data > 0xffffffff) {
        throw new Error(`Refusing invalid REG_DWORD value: ${change.data}`)
      }
      data = String(change.data)
    } else {
      data = literal(change.data, SAFE_STRING)
    }
    return `& reg.exe add ${k} /v ${name} /t ${change.type} /d ${data} /f /reg:64 | Out-Null; ${fail}`
  })
  return [...lines, 'exit 0'].join('\n')
}

/** The non-elevated PowerShell command that raises UAC and returns the script's exit code. */
export function buildElevationCommand(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return (
    `try { $p = Start-Process -FilePath 'powershell.exe' ` +
    `-ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded}' ` +
    `-Verb RunAs -WindowStyle Hidden -Wait -PassThru -ErrorAction Stop } ` +
    // Start-Process throws when the UAC prompt is declined.
    `catch { exit ${ERROR_CANCELLED} }; exit $p.ExitCode`
  )
}

export async function runElevatedRegistryChanges(
  key: string,
  changes: RegistryValueChange[],
): Promise<ElevatedRunResult> {
  let command: string
  try {
    command = buildElevationCommand(buildRegistryScript(key, changes))
  } catch (e) {
    return { ok: false, cancelled: false, error: e instanceof Error ? e.message : String(e) }
  }
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true,
    })
    return { ok: true }
  } catch (e) {
    const code = (e as { code?: unknown }).code
    if (code === ERROR_CANCELLED) {
      return { ok: false, cancelled: true, error: 'Administrator approval was cancelled' }
    }
    return {
      ok: false,
      cancelled: false,
      error: `Elevated registry write failed (exit code ${String(code)})`,
    }
  }
}
