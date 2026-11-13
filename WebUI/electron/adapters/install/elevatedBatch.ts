import { execFile } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import * as filesystem from 'fs-extra'

const execFileAsync = promisify(execFile)

type BatchLogger = {
  info: (message: string, source: string) => void
  warn: (message: string, source: string) => void
}

export function elevatedScriptBody(commands: string[]): string | null {
  const steps = commands.filter((command) => command.trim().length > 0)
  if (steps.length === 0) return null
  return ['@echo off', ...steps].join('\r\n')
}

export function elevatedPowershellArgs(scriptPath: string, workingDirectory: string): string[] {
  const escapedScriptPath = scriptPath.replaceAll("'", "''")
  const escapedWorkingDirectory = workingDirectory.replaceAll("'", "''")
  return [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Start-Process -FilePath '${escapedScriptPath}' -WorkingDirectory '${escapedWorkingDirectory}' -Verb RunAs -Wait`,
  ]
}

/**
 * Runs one or more shell commands inside a single elevated (UAC) session.
 *
 * All steps are written to a temporary `.cmd` script launched once via
 * `Start-Process -Verb RunAs -Wait`, so a multi-step elevated operation triggers a single
 * UAC prompt instead of one prompt per step. Individual command failures do not abort the
 * batch — the script runs every line so best-effort teardown steps (e.g. `taskkill` when
 * nothing is running) cannot block the remaining work.
 */
export async function runElevatedBatch(
  commands: string[],
  workingDirectory: string,
  opts: { name: string; logger: BatchLogger },
): Promise<void> {
  const scriptBody = elevatedScriptBody(commands)
  if (scriptBody === null) {
    return
  }
  const logger = opts.logger

  logger.info(
    `Running ${scriptBody.split('\r\n').length - 1} elevated command(s) in a single UAC prompt`,
    opts.name,
  )

  const scriptPath = path.join(os.tmpdir(), `aipg-phison-elevated-${Date.now()}.cmd`)
  await filesystem.writeFile(scriptPath, scriptBody, 'utf8')

  try {
    const { stdout, stderr } = await execFileAsync(
      'powershell.exe',
      elevatedPowershellArgs(scriptPath, workingDirectory),
      { windowsHide: true },
    )

    if (stdout) {
      logger.info(stdout, opts.name)
    }
    if (stderr) {
      logger.warn(stderr, opts.name)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to run elevated batch: ${message}`)
  } finally {
    try {
      await filesystem.remove(scriptPath)
    } catch (cleanupError) {
      logger.warn(
        `Failed to remove temporary elevated script ${scriptPath}: ${cleanupError}`,
        opts.name,
      )
    }
  }
}
