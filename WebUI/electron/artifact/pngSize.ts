import { closeSync, openSync, readSync } from 'node:fs'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Width/height out of a PNG file's IHDR header (the first 24 bytes). */
export function pngDimensionsFromHeader(header: Buffer): { width: number; height: number } | null {
  if (header.length < 24) return null
  if (!header.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (header.toString('ascii', 12, 16) !== 'IHDR') return null
  const width = header.readUInt32BE(16)
  const height = header.readUInt32BE(20)
  if (!width || !height) return null
  return { width, height }
}

// Synchronous on purpose: the websocket message handler is fire-and-forget, and
// an awaited read here could let execution_success settle the run first.
export function pngDimensions(fsPath: string): { width: number; height: number } | null {
  let fd: number | undefined
  try {
    fd = openSync(fsPath, 'r')
    const header = Buffer.alloc(24)
    if (readSync(fd, header, 0, 24, 0) < 24) return null
    return pngDimensionsFromHeader(header)
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
