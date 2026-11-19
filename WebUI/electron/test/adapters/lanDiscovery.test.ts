import { describe, expect, it } from 'vitest'
import { encodeTxt, parseService } from '../../adapters/lanDiscovery'

const fingerprint = 'ab'.repeat(32)

describe('LAN discovery records', () => {
  it('advertises a short fingerprint hint and the pairing state', () => {
    expect(encodeTxt({ port: 47800, name: 'ws-1', fingerprint, pairingOpen: true })).toEqual({
      v: '1',
      name: 'ws-1',
      fp: 'abababababababab',
      pairing: '1',
    })
  })

  it('parses a browsed service, preferring IPv4 addresses', () => {
    const txt = encodeTxt({ port: 47800, name: 'ws-1', fingerprint, pairingOpen: false })
    expect(
      parseService({
        name: 'ws-1',
        host: 'ws-1.local',
        port: 47800,
        addresses: ['fe80::1', '192.168.1.20'],
        txt,
      }),
    ).toEqual({
      name: 'ws-1',
      hostname: 'ws-1.local',
      addresses: ['192.168.1.20'],
      port: 47800,
      fingerprintHint: 'abababababababab',
      pairingOpen: false,
    })
  })

  it('falls back to the address the answer came from, and reads Buffer TXT values', () => {
    const parsed = parseService({
      port: 47800,
      referer: { address: '10.0.0.5' },
      txt: { v: Buffer.from('1'), pairing: Buffer.from('1'), name: Buffer.from('box') },
    })
    expect(parsed?.addresses).toEqual(['10.0.0.5'])
    expect(parsed?.pairingOpen).toBe(true)
    expect(parsed?.name).toBe('box')
  })

  it('ignores services from another protocol version or without an address', () => {
    expect(parseService({ port: 1, addresses: ['10.0.0.5'], txt: { v: '2' } })).toBeNull()
    expect(parseService({ port: 1, addresses: [], txt: { v: '1' } })).toBeNull()
  })
})
