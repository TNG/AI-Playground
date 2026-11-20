import type { Dirent } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { appLoggerInstance } from '../observability/logger'

// The file moves Sessions and Workspaces share: whole arrivals, free names, folder merges.

const LOG_SCOPE = 'file-ops'

/** OS litter: never counted or moved, and no reason to keep an emptied folder. */
const LITTER = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** Whether anything, a broken link included, is at `file`. */
export async function exists(file: string): Promise<boolean> {
  return fs.lstat(file).then(
    () => true,
    () => false,
  )
}

/** Whether both files hold the same bytes; false when either cannot be read. */
export async function sameContent(a: string, b: string): Promise<boolean> {
  const [left, right] = (await Promise.allSettled([fs.open(a, 'r'), fs.open(b, 'r')])).map(
    (opened) => (opened.status === 'fulfilled' ? opened.value : undefined),
  )
  try {
    if (!left || !right) return false
    const [leftStat, rightStat] = await Promise.all([left.stat(), right.stat()])
    if (leftStat.size !== rightStat.size) return false
    const size = 64 * 1024
    const [leftChunk, rightChunk] = [Buffer.alloc(size), Buffer.alloc(size)]
    for (let position = 0; position < leftStat.size; position += size) {
      const [l, r] = await Promise.all([
        left.read(leftChunk, 0, size, position),
        right.read(rightChunk, 0, size, position),
      ])
      if (!leftChunk.subarray(0, l.bytesRead).equals(rightChunk.subarray(0, r.bytesRead))) {
        return false
      }
    }
    return true
  } catch {
    return false
  } finally {
    await Promise.all([left?.close(), right?.close()])
  }
}

/** Moves a file or folder; across volumes it is copied beside `to` first, so it arrives whole. */
export async function moveEntry(from: string, to: string): Promise<void> {
  await fs.mkdir(path.dirname(to), { recursive: true })
  try {
    await fs.rename(from, to)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
    const partial = `${to}.moving`
    await fs.rm(partial, { recursive: true, force: true })
    await fs.cp(from, partial, { recursive: true, errorOnExist: true, force: false })
    await fs.rename(partial, to)
    await fs.rm(from, { recursive: true, force: true })
  }
}

/** The first name `claim` takes, trying `nameAt(1)`, `nameAt(2)`, … */
export async function firstFree(
  nameAt: (n: number) => string,
  claim: (name: string) => Promise<boolean>,
): Promise<string> {
  for (let n = 1; ; n++) {
    const name = nameAt(n)
    if (await claim(name)) return name
  }
}

/** `name`, `name-1`, `name-2`, … */
export function dashNumbered(name: string): (n: number) => string {
  const { name: stem, ext } = path.parse(name)
  return (n) => (n === 1 ? name : `${stem}-${n - 1}${ext}`)
}

/** `name`, `name (2)`, `name (3)`, … */
function parenNumbered(name: string): (n: number) => string {
  return (n) => (n === 1 ? name : `${name} (${n})`)
}

const notTakenIn = (dir: string) => async (name: string) => !(await exists(path.join(dir, name)))

/** `name`, or `name-1`, `name-2`, … — the first that is not taken in `dir`. */
export async function freeName(dir: string, name: string): Promise<string> {
  return firstFree(dashNumbered(name), notTakenIn(dir))
}

/** Where `name` or `name (n)` is free in `parent`; nothing is made there. */
export async function freeFolderPath(parent: string, name: string): Promise<string> {
  return path.join(parent, await firstFree(parenNumbered(name), notTakenIn(parent)))
}

/** Makes `name` or `name (n)` in `parent`, never one that exists; its path. */
export async function createFreeFolder(parent: string, name: string): Promise<string> {
  await fs.mkdir(parent, { recursive: true })
  const made = await firstFree(parenNumbered(name), async (candidate) => {
    try {
      await fs.mkdir(path.join(parent, candidate))
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return false
    }
  })
  return path.join(parent, made)
}

async function sameFolder(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([fs.stat(a), fs.stat(b)])
    return left.dev === right.dev && left.ino === right.ino
  } catch {
    return false
  }
}

/** Renames `from` to `name` or `name (n)` beside it; a case-only change keeps the same folder. */
export async function renameToFree(from: string, name: string): Promise<string> {
  const parent = path.dirname(from)
  const renamed = await firstFree(parenNumbered(name), async (candidate) => {
    const to = path.join(parent, candidate)
    if ((await exists(to)) && !(await sameFolder(from, to))) return false
    await fs.rename(from, to)
    return true
  })
  return path.join(parent, renamed)
}

export async function ensureFolder(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

/** Removes `dir` only when it is empty. */
export async function removeEmptyFolder(dir: string): Promise<void> {
  await fs.rmdir(dir).catch(() => {})
}

/** What `dir` holds besides OS litter; nothing when it is missing. */
export async function entriesOf(dir: string): Promise<Dirent[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter(
      (entry) => !LITTER.has(entry.name),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

/** The files in `dir` and below it, OS litter not counted. */
export async function countFiles(dir: string): Promise<number> {
  let count = 0
  for (const entry of await entriesOf(dir)) {
    count += entry.isDirectory() ? await countFiles(path.join(dir, entry.name)) : 1
  }
  return count
}

/** Removes `dir` when nothing but OS litter is left in it; whether it is gone. */
async function removeIfEmpty(dir: string): Promise<boolean> {
  if ((await entriesOf(dir)).length > 0) return false
  try {
    await fs.rm(dir, { recursive: true, force: true })
    return true
  } catch (error) {
    appLoggerInstance.warn(`could not remove ${dir}: ${String(error)}`, LOG_SCOPE)
    return false
  }
}

/**
 * Moves everything in `from` into `to`, then removes `from` once empty: a file that already
 * arrived is dropped, a different one takes a free name. Returns how many files moved.
 */
export async function mergeInto(from: string, to: string): Promise<number> {
  const entries = await entriesOf(from)
  let moved = 0
  for (const entry of entries) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) {
      if (await exists(target)) moved += await mergeInto(source, target)
      else {
        const count = await countFiles(source)
        await moveEntry(source, target)
        moved += count
      }
      continue
    }
    if (!(await exists(target))) {
      await moveEntry(source, target)
      moved += 1
    } else if (await sameContent(source, target)) {
      await fs.unlink(source)
    } else {
      await moveEntry(source, path.join(to, await freeName(to, entry.name)))
      moved += 1
    }
  }
  await removeIfEmpty(from)
  return moved
}
