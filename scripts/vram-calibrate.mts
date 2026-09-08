#!/usr/bin/env node
/**
 * Run on a machine that has the GGUF: parse the header, print the VRAM estimate.
 * Does not start llama-server. Compare the total to WDDM process memory yourself.
 *
 *   node --experimental-strip-types scripts/vram-calibrate.mts --model path.gguf --ctx 32000
 */
import fs from 'node:fs'
import { parseGgufMetadata, type GgufReader } from '../WebUI/src/lib/vram/gguf.ts'
import { archFromMetadata } from '../WebUI/src/lib/vram/arch.ts'
import { estimateLlamaCppVram } from '../WebUI/src/lib/vram/estimate.ts'
import { bytesToMiB } from '../WebUI/src/lib/vram/units.ts'

function fileReader(path: string): { reader: GgufReader; close: () => void } {
  const fd = fs.openSync(path, 'r')
  let pos = 0
  return {
    reader: {
      read(n) {
        const buf = Buffer.allocUnsafe(n)
        let got = 0
        while (got < n) {
          const read = fs.readSync(fd, buf, got, n - got, pos)
          if (read === 0) throw new Error(`Unexpected EOF in ${path}`)
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

function readArch(path: string) {
  const { reader, close } = fileReader(path)
  try {
    return archFromMetadata(parseGgufMetadata(reader))
  } finally {
    close()
  }
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i < 0) return undefined
  return process.argv[i + 1]
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

const modelPath = arg('model')
if (!modelPath) {
  console.error('usage: --model <gguf> [--mmproj <gguf>] [--ctx N] [--mtp]')
  process.exit(1)
}

const mmprojPath = arg('mmproj')
const contextSize = Number(arg('ctx') ?? 32000)
const arch = readArch(modelPath)
const weightsBytes = fs.statSync(modelPath).size
const mmprojBytes = mmprojPath ? fs.statSync(mmprojPath).size : 0
const estimate = estimateLlamaCppVram({
  arch,
  weightsBytes,
  mmprojBytes,
  contextSize,
  mtp: flag('mtp'),
})

const mib = (n: number) => `${bytesToMiB(n).toFixed(1)} MiB`

console.log(
  JSON.stringify(
    {
      model: modelPath,
      mmproj: mmprojPath ?? null,
      contextSize,
      architecture: arch.architecture,
      kvPath: estimate.kvPath,
      arch: {
        blockCount: arch.blockCount,
        embeddingLength: arch.embeddingLength,
        vocabSize: arch.vocabSize,
        headCount: arch.headCount,
        headCountKv: arch.headCountKv,
        keyLength: arch.keyLength,
        valueLength: arch.valueLength,
        fullAttentionInterval: arch.fullAttentionInterval,
        ssmInnerSize: arch.ssmInnerSize,
        nextnPredictLayers: arch.nextnPredictLayers,
        slidingWindow: arch.slidingWindow,
      },
      bytes: estimate,
      mib: {
        weights: mib(estimate.weightsBytes),
        kvCache: mib(estimate.kvCacheBytes),
        recurrent: mib(estimate.recurrentStateBytes),
        compute: mib(estimate.computeBufferBytes),
        mtp: mib(estimate.mtpBytes),
        total: mib(estimate.totalBytes),
      },
    },
    null,
    2,
  ),
)
