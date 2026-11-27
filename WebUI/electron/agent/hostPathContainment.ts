import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export function isFolder(hostPath: string): boolean {
  try {
    return fs.statSync(hostPath).isDirectory()
  } catch {
    return false
  }
}

/** Whether host path `candidate` is `root` or below it, compared as written. */
export function containedIn(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** The real file `candidate` (relative to `root`) names, when it exists strictly below `root`. */
export function realFileInside(root: string, candidate: string): string | null {
  let realRoot: string
  let real: string
  try {
    realRoot = fs.realpathSync(root)
    real = fs.realpathSync(path.resolve(realRoot, candidate))
  } catch {
    return null
  }
  return real !== realRoot && containedIn(realRoot, real) ? real : null
}

/**
 * Where `candidate` really lands once symlinks are followed, for a path that
 * may not exist yet: its deepest existing ancestor is resolved and the rest is
 * appended. A dangling link is followed to its target, which a write creates.
 */
export async function realDestination(candidate: string, hops = 0): Promise<string> {
  try {
    return await fsp.realpath(candidate)
  } catch {
    const parent = path.dirname(candidate)
    if (parent === candidate || hops > 40) return candidate
    const link = await fsp.readlink(candidate).catch(() => null)
    if (link !== null) return realDestination(path.resolve(parent, link), hops + 1)
    return path.join(await realDestination(parent, hops), path.basename(candidate))
  }
}
