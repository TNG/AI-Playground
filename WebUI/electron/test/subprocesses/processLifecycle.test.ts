import { describe, it, expect, vi } from 'vitest'
import * as childProcess from 'node:child_process'
import os from 'node:os'
import type { ChildProcess } from 'node:child_process'

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}))

vi.mock('../../logging/logger.ts', () => ({
  appLoggerInstance: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const {
  killStaleProcessesByCommandLine,
  reapOrphansFromPreviousSession,
  spawnBackend,
  terminateProcessTree,
} = await import('../../subprocesses/processLifecycle.ts')

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
const posixOnly = process.platform === 'win32' ? it.skip : it

/**
 * A killed orphan stays in the process table until something reaps it, and
 * `process.kill(pid, 0)` happily reports those zombies as alive. Only a running
 * state means the process still holds its port and memory.
 */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  try {
    const state = childProcess.execFileSync('ps', ['-o', 'stat=', '-p', String(pid)]).toString()
    return !state.trim().startsWith('Z')
  } catch {
    return false
  }
}

const settled = (proc: ChildProcess): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) {
      resolve()
      return
    }
    proc.once('exit', () => resolve())
  })

/**
 * A shell that spawns one background child and waits — the shape of every real
 * backend (uv -> python, ovms -> its workers). Resolves once the grandchild's
 * pid has been printed.
 */
async function spawnLeaderWithGrandchild(
  spawner: (cmd: string, args: string[]) => ChildProcess,
  marker: string,
): Promise<{ leader: ChildProcess; grandchildPid: number }> {
  const leader = spawner('sh', ['-c', `sleep 120 & echo $! ; wait # ${marker}`])
  const grandchildPid = await new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('grandchild pid never arrived')), 5000)
    leader.stdout?.once('data', (data: Buffer) => {
      clearTimeout(timeout)
      resolve(Number.parseInt(data.toString().trim(), 10))
    })
  })
  return { leader, grandchildPid }
}

describe('spawnBackend', () => {
  posixOnly('makes the child its own process-group leader', () => {
    const proc = spawnBackend('sleep', ['30'], { stdio: 'ignore' })
    try {
      // A group only answers to its leader's pid, so this throws for a child
      // that merely inherited the parent's group.
      expect(() => process.kill(-proc.pid!, 0)).not.toThrow()
    } finally {
      process.kill(-proc.pid!, 'SIGKILL')
    }
  })
})

describe('terminateProcessTree', () => {
  posixOnly('reaps grandchildren of a backend it spawned', async () => {
    const { leader, grandchildPid } = await spawnLeaderWithGrandchild(
      (cmd, args) => spawnBackend(cmd, args, { stdio: 'pipe' }),
      'aipg-teardown-test',
    )
    expect(alive(grandchildPid)).toBe(true)

    await terminateProcessTree(leader, {
      name: 'test-backend',
      gracefulMs: 500,
      appLogger: silentLogger,
    })

    expect(alive(leader.pid!)).toBe(false)
    expect(alive(grandchildPid)).toBe(false)
  })

  posixOnly('falls back to the direct child when there is no process group', async () => {
    // Plain spawn: the child shares our group, so kill(-pid) has nothing to hit.
    const { leader, grandchildPid } = await spawnLeaderWithGrandchild(
      (cmd, args) => childProcess.spawn(cmd, args, { stdio: 'pipe' }),
      'aipg-fallback-test',
    )

    await terminateProcessTree(leader, {
      name: 'test-backend',
      gracefulMs: 500,
      appLogger: silentLogger,
    })

    expect(alive(leader.pid!)).toBe(false)
    // The grandchild survives — that is the leak this whole change is about,
    // and it is only avoidable for processes we spawn ourselves.
    expect(alive(grandchildPid)).toBe(true)
    process.kill(grandchildPid, 'SIGKILL')
  })

  it('does nothing for a process that already exited', async () => {
    const proc = childProcess.spawn('sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    await settled(proc)
    const killSpy = vi.spyOn(proc, 'kill')

    await terminateProcessTree(proc, { name: 'test-backend', appLogger: silentLogger })

    expect(killSpy).not.toHaveBeenCalled()
  })
})

describe('killStaleProcessesByCommandLine', () => {
  posixOnly('kills a match and everything in its group', async () => {
    const marker = `aipg-stale-${process.pid}-${Date.now()}`
    const { leader, grandchildPid } = await spawnLeaderWithGrandchild(
      (cmd, args) => spawnBackend(cmd, args, { stdio: 'pipe' }),
      marker,
    )

    await killStaleProcessesByCommandLine(marker, { name: 'test-backend', appLogger: silentLogger })
    await settled(leader)

    expect(alive(leader.pid!)).toBe(false)
    expect(alive(grandchildPid)).toBe(false)
  })

  posixOnly('spares excluded pids', async () => {
    const marker = `aipg-excluded-${process.pid}-${Date.now()}`
    const proc = spawnBackend('sh', ['-c', `sleep 120 # ${marker}`], { stdio: 'ignore' })
    // Give the shell a moment to appear in the process table.
    await new Promise((resolve) => setTimeout(resolve, 200))

    await killStaleProcessesByCommandLine(marker, {
      name: 'test-backend',
      excludePids: [proc.pid!],
      appLogger: silentLogger,
    })

    expect(alive(proc.pid!)).toBe(true)
    process.kill(-proc.pid!, 'SIGKILL')
  })
})

describe('reapOrphansFromPreviousSession', () => {
  posixOnly('sweeps every signature of every target', async () => {
    const marker = `aipg-orphan-${process.pid}-${Date.now()}`
    const orphan = spawnBackend('sh', ['-c', `sleep 120 # ${marker}`], { stdio: 'ignore' })
    await new Promise((resolve) => setTimeout(resolve, 200))

    await reapOrphansFromPreviousSession(
      [
        { name: 'nothing-matches', signatures: [`${marker}-absent`] },
        { name: 'test-backend', signatures: [marker] },
      ],
      { appLogger: silentLogger },
    )
    await settled(orphan)

    expect(alive(orphan.pid!)).toBe(false)
  })

  it('ignores targets without signatures', async () => {
    await expect(
      reapOrphansFromPreviousSession([{ name: 'test-backend', signatures: [] }], {
        appLogger: silentLogger,
      }),
    ).resolves.toBeUndefined()
  })
})
