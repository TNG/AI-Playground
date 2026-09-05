import fs from 'node:fs'

import { parseGgufMetadata, type GgufMetadata, type GgufReader } from '@/lib/vram/gguf'

export function fileGgufReader(path: string): { reader: GgufReader; close: () => void } {
  const fd = fs.openSync(path, 'r')
  let pos = 0
  return {
    reader: {
      read(n) {
        const buf = Buffer.allocUnsafe(n)
        let got = 0
        while (got < n) {
          const read = fs.readSync(fd, buf, got, n - got, pos)
          if (read === 0) throw new Error('Unexpected EOF in GGUF header')
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

export function readGgufMetadataFromFile(path: string): GgufMetadata {
  const { reader, close } = fileGgufReader(path)
  try {
    return parseGgufMetadata(reader)
  } finally {
    close()
  }
}
