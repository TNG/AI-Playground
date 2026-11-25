import fs from 'node:fs/promises'
import path from 'node:path'
import {
  dashNumbered,
  firstFree,
  freeName,
  moveEntry,
  nextNumberedName,
  sameContent,
  type ReservedNames,
} from './fileOps'
import { discardPath } from './sessionFiles'

const READER_COPIES_DIR = 'generated'

/** Moves generated media into `dir` at the next number in its series; that name, or null. */
export async function moveGeneratedIntoFolder(
  dir: string,
  source: string,
  reserved?: ReservedNames,
): Promise<string | null> {
  if (!(await fs.stat(source)).isFile()) return null
  const name = await nextNumberedName(dir, path.basename(source), reserved)
  await moveEntry(source, path.join(dir, name))
  return name
}

export async function copyIntoFolder(
  dir: string,
  source: string,
  reserved?: ReservedNames,
): Promise<string | null> {
  if (!(await fs.stat(source)).isFile()) return null
  const name = await freeName(dir, path.basename(source), reserved)
  await fs.copyFile(source, path.join(dir, name))
  return name
}

/** Writes new bytes into `dir` under a free name; that name. */
export async function writeNewFile(
  dir: string,
  preferredName: string,
  bytes: Buffer,
  reserved?: ReservedNames,
): Promise<string> {
  const name = await freeName(dir, preferredName, reserved)
  await fs.writeFile(path.join(dir, name), bytes, { flag: 'wx' })
  return name
}

/** Discards one regular file (to the Trash outside demo mode); a missing one is already gone. */
export async function discardRegularFile(file: string): Promise<void> {
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error(`not a file: ${file}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  await discardPath(file)
}

/**
 * A reader's copy of a Session file in its Workspace, made on first need; its relative path.
 * A name already holding other bytes is another file's copy, so this one takes a free name.
 */
export async function ensureReaderCopy(
  source: string,
  workspaceDir: string,
): Promise<string | null> {
  const dir = path.join(workspaceDir, READER_COPIES_DIR)
  try {
    await fs.mkdir(dir, { recursive: true })
    const name = await firstFree(dashNumbered(path.basename(source)), async (candidate) => {
      const target = path.join(dir, candidate)
      try {
        await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL)
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      }
      return sameContent(source, target)
    })
    return path.posix.join(READER_COPIES_DIR, name)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}
