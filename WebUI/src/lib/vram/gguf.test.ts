import { describe, expect, it } from 'vitest'
import { encodeGgufMetadata, parseGgufMetadataBytes, type EncodeValue } from './gguf.ts'
import { archFromMetadata } from './arch.ts'

function encode(pairs: Record<string, EncodeValue>) {
  return encodeGgufMetadata(Object.entries(pairs))
}

describe('parseGgufMetadata', () => {
  it('round-trips architecture scalars and skips a tokenizer without decoding it', () => {
    const bytes = encode({
      'general.architecture': { type: 'string', value: 'qwen35' },
      'qwen35.block_count': { type: 'u32', value: 32 },
      'qwen35.embedding_length': { type: 'u32', value: 4096 },
      'qwen35.attention.head_count': { type: 'u32', value: 16 },
      'qwen35.attention.head_count_kv': { type: 'u32', value: 4 },
      'qwen35.attention.key_length': { type: 'u32', value: 256 },
      'qwen35.attention.value_length': { type: 'u32', value: 256 },
      'tokenizer.ggml.tokens': { type: 'string[]', value: ['<|im_start|>', 'hello', 'world'] },
    })
    const meta = parseGgufMetadataBytes(bytes)
    expect(meta.architecture).toBe('qwen35')
    expect(meta.vocabSize).toBe(3)
    expect(meta.values.get('qwen35.block_count')).toBe(32)
    expect(meta.values.has('tokenizer.ggml.tokens')).toBe(false)
  })

  it('reads a per-layer head_count_kv array', () => {
    const bytes = encode({
      'general.architecture': { type: 'string', value: 'gemma4' },
      'gemma4.attention.head_count_kv': { type: 'u32[]', value: [1, 1, 4, 1] },
    })
    const arch = archFromMetadata(parseGgufMetadataBytes(bytes))
    expect(arch.headCountKvByLayer).toEqual([1, 1, 4, 1])
    expect(arch.headCountKv).toBe(4)
  })

  it('expands a sliding-window period into a per-layer pattern', () => {
    const bytes = encode({
      'general.architecture': { type: 'string', value: 'gemma3' },
      'gemma3.block_count': { type: 'u32', value: 6 },
      'gemma3.attention.sliding_window': { type: 'u32', value: 512 },
      'gemma3.attention.sliding_window_pattern': { type: 'u32', value: 6 },
    })
    const arch = archFromMetadata(parseGgufMetadataBytes(bytes))
    expect(arch.slidingWindowPattern).toEqual([true, true, true, true, true, false])
  })

  it('keeps an explicit sliding-window bool pattern', () => {
    const bytes = encode({
      'general.architecture': { type: 'string', value: 'gemma3' },
      'gemma3.block_count': { type: 'u32', value: 4 },
      'gemma3.attention.sliding_window_pattern': {
        type: 'bool[]',
        value: [true, true, false, true],
      },
    })
    const arch = archFromMetadata(parseGgufMetadataBytes(bytes))
    expect(arch.slidingWindowPattern).toEqual([true, true, false, true])
  })

  it('defaults gemma3 sliding-window period to 6 when the header omits it', () => {
    const bytes = encode({
      'general.architecture': { type: 'string', value: 'gemma3' },
      'gemma3.block_count': { type: 'u32', value: 6 },
      'gemma3.attention.sliding_window': { type: 'u32', value: 1024 },
    })
    const arch = archFromMetadata(parseGgufMetadataBytes(bytes))
    expect(arch.slidingWindowPattern).toEqual([true, true, true, true, true, false])
  })

  it('rejects a non-GGUF header', () => {
    expect(() => parseGgufMetadataBytes(new Uint8Array([1, 2, 3, 4]))).toThrow(/Not a GGUF/)
  })
})
