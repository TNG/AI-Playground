import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { pngDimensions, pngDimensionsFromHeader } from '../../artifact/pngSize'

function pngHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(24)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0)
  header.writeUInt32BE(13, 8)
  header.write('IHDR', 12, 'ascii')
  header.writeUInt32BE(width, 16)
  header.writeUInt32BE(height, 20)
  return header
}

const tempFiles: string[] = []

function tempFile(bytes: Buffer): string {
  const dir = path.join(os.tmpdir(), `pngSize-${process.pid}`)
  mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `t${tempFiles.length}.png`)
  writeFileSync(file, bytes)
  tempFiles.push(file)
  return file
}

afterEach(() => {
  for (const file of tempFiles.splice(0)) rmSync(file, { force: true })
})

describe('pngDimensionsFromHeader', () => {
  it('reads the IHDR dimensions', () => {
    expect(pngDimensionsFromHeader(pngHeader(704, 704))).toEqual({ width: 704, height: 704 })
    expect(pngDimensionsFromHeader(pngHeader(1536, 640))).toEqual({ width: 1536, height: 640 })
  })

  it('rejects a non-PNG or truncated header', () => {
    expect(pngDimensionsFromHeader(Buffer.from('not a png file at all.....'))).toBeNull()
    expect(pngDimensionsFromHeader(pngHeader(512, 512).subarray(0, 16))).toBeNull()
  })

  it('rejects zero dimensions', () => {
    expect(pngDimensionsFromHeader(pngHeader(0, 512))).toBeNull()
  })
})

describe('pngDimensions', () => {
  it('reads the dimensions of a file', () => {
    expect(pngDimensions(tempFile(pngHeader(512, 512)))).toEqual({ width: 512, height: 512 })
  })

  it('returns null for a missing file', () => {
    expect(pngDimensions(path.join(os.tmpdir(), 'pngSize-no-such-file.png'))).toBeNull()
  })
})
