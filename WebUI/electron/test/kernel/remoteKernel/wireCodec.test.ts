import { describe, expect, it } from 'vitest'
import { decodeWire, encodeWire } from '../../../kernel/remoteKernel/wireCodec'
import { loopbackRewriter } from '../../../kernel/remoteKernel/protocol'

describe('remote-kernel wire codec', () => {
  it('round-trips bytes, undefined arguments and nested values', () => {
    const args = ['dir', 'sprite.png', new Uint8Array([1, 2, 250]), undefined, { a: [1, 'x'] }]
    const decoded = decodeWire<unknown[]>(encodeWire(args))
    expect(decoded).toHaveLength(5)
    expect(Buffer.isBuffer(decoded[2])).toBe(true)
    expect([...(decoded[2] as Buffer)]).toEqual([1, 2, 250])
    expect(decoded[3]).toBeUndefined()
    expect(decoded[4]).toEqual({ a: [1, 'x'] })
  })

  it('round-trips a Buffer at the top level', () => {
    const decoded = decodeWire<Buffer>(encodeWire(Buffer.from('hello')))
    expect(decoded.toString()).toBe('hello')
  })

  it('maps strings on both sides', () => {
    const upper = (value: string) => value.toUpperCase()
    expect(decodeWire(encodeWire({ a: 'x', b: ['y'] }, upper))).toEqual({ a: 'X', b: ['Y'] })
    expect(decodeWire(encodeWire({ a: 'x' }), upper)).toEqual({ a: 'X' })
  })
})

describe('loopback rewriter', () => {
  const rewrite = loopbackRewriter(41234)

  it('puts workstation service URLs on the local tunnel and back', () => {
    const inbound = rewrite.inbound('http://127.0.0.1:59001/api/getModelSize')
    expect(inbound).toBe('http://127.0.0.1:41234/svc/59001/api/getModelSize')
    expect(rewrite.outbound(inbound)).toBe('http://127.0.0.1:59001/api/getModelSize')
    expect(rewrite.inbound('http://localhost:39100')).toBe('http://127.0.0.1:41234/svc/39100')
  })

  it('leaves everything else alone', () => {
    for (const value of [
      'aipg-media://media/a.png',
      'http://127.0.0.1:25413/index.html',
      'https://huggingface.co',
      'see http://127.0.0.1:59001 later',
      'http://127.0.0.1:590011',
    ]) {
      expect(rewrite.inbound(value), value).toBe(value)
    }
  })
})
