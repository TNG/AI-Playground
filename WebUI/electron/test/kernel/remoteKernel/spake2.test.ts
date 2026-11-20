import { describe, expect, it } from 'vitest'
import crypto from 'node:crypto'
import { createSpake2Party, passwordScalar } from '../../../kernel/remoteKernel/spake2'

// RFC 9382 Appendix B, SPAKE2-P256-SHA256-HKDF-HMAC: w, x and y are given; everything else
// must come out of the implementation.
const VECTORS = [
  {
    A: 'server',
    B: 'client',
    w: '2ee57912099d31560b3a44b1184b9b4866e904c49d12ac5042c97dca461b1a5f',
    x: '43dd0fd7215bdcb482879fca3220c6a968e66d70b1356cac18bb26c84a78d729',
    y: 'dcb60106f276b02606d8ef0a328c02e4b629f84f89786af5befb0bc75b6e66be',
    pA: '04a56fa807caaa53a4d28dbb9853b9815c61a411118a6fe516a8798434751470f9010153ac33d0d5f2047ffdb1a3e42c9b4e6be662766e1eeb4116988ede5f912c',
    pB: '0406557e482bd03097ad0cbaa5df82115460d951e3451962f1eaf4367a420676d09857ccbc522686c83d1852abfa8ed6e4a1155cf8f1543ceca528afb591a1e0b7',
    Ke: '0e0672dc86f8e45565d338b0540abe69',
    confA: '58ad4aa88e0b60d5061eb6b5dd93e80d9c4f00d127c65b3b35b1b5281fee38f0',
    confB: 'd3e2e547f1ae04f2dbdbf0fc4b79f8ecff2dff314b5d32fe9fcef2fb26dc459b',
  },
  {
    A: '',
    B: 'client',
    w: '0548d8729f730589e579b0475a582c1608138ddf7054b73b5381c7e883e2efae',
    x: '403abbe3b1b4b9ba17e3032849759d723939a27a27b9d921c500edde18ed654b',
    y: '903023b6598908936ea7c929bd761af6039577a9c3f9581064187c3049d87065',
    pA: '04a897b769e681c62ac1c2357319a3d363f610839c4477720d24cbe32f5fd85f44fb92ba966578c1b712be6962498834078262caa5b441ecfa9d4a9485720e918a',
    pB: '04e0f816fd1c35e22065d5556215c097e799390d16661c386e0ecc84593974a61b881a8c82327687d0501862970c64565560cb5671f696048050ca66ca5f8cc7fc',
    Ke: '642f05c473c2cd79909f9a841e2f30a7',
    confA: '47d29e6666af1b7dd450d571233085d7a9866e4d49d2645e2df975489521232b',
    confB: '3313c5cefc361d27fb16847a91c2a73b766ffa90a4839122a9b70a2f6bd1d6df',
  },
  {
    A: 'server',
    B: '',
    w: '626e0cdc7b14c9db3e52a0b1b3a768c98e37852d5db30febe0497b14eae8c254',
    x: '07adb3db6bc623d3399726bfdbfd3d15a58ea776ab8a308b00392621291f9633',
    y: 'b6a4fc8dbb629d4ba51d6f91ed1532cf87adec98f25dd153a75accafafedec16',
    pA: '04f88fb71c99bfffaea370966b7eb99cd4be0ff1a7d335caac4211c4afd855e2e15a873b298503ad8ba1d9cbb9a392d2ba309b48bfd7879aefd0f2cea6009763b0',
    pB: '040c269d6be017dccb15182ac6bfcd9e2a14de019dd587eaf4bdfd353f031101e7cca177f8eb362a6e83e7d5e729c0732e1b528879c086f39ba0f31a9661bd34db',
    Ke: '005184ff460da2ce59062c87733c299c',
    confA: 'bc9f9bbe99f26d0b2260e6456e05a86196a3307ec6663a18bf6ac825736533b2',
    confB: 'c2370e1bf813b086dff0d834e74425a06e6390f48f5411900276dcccc5a297ec',
  },
  {
    A: '',
    B: '',
    w: '7bf46c454b4c1b25799527d896508afd5fc62ef4ec59db1efb49113063d70cca',
    x: '8cef65df64bb2d0f83540c53632de911b5b24b3eab6cc74a97609fd659e95473',
    y: 'd7a66f64074a84652d8d623a92e20c9675c61cb5b4f6a0063e4648a2fdc02d53',
    pA: '04a65b367a3f613cf9f0654b1b28a1e3a8a40387956c8ba6063e8658563890f46ca1ef6a676598889fc28de2950ab8120b79a5ef1ea4c9f44bc98f585634b46d66',
    pB: '04589f13218822710d98d8b2123a079041052d9941b9cf88c6617ddb2fcc0494662eea8ba6b64692dc318250030c6af045cb738bc81ba35b043c3dcb46adf6f58d',
    Ke: 'fc6374762ba5cf11f4b2caa08b2cd1b9',
    confA: 'dfb4db8d48ae5a675963ea5e6c19d98d4ea028d8e898dad96ea19a80ade95dca',
    confB: 'd0f0609d1613138d354f7e95f19fb556bf52d751947241e8c7118df5ef0ae175',
  },
]

const big = (hex: string) => BigInt(`0x${hex}`)
const hex = (buffer: Buffer) => buffer.toString('hex')

describe('SPAKE2 (RFC 9382)', () => {
  it.each(VECTORS)('reproduces the RFC vector for A=$A B=$B', (vector) => {
    const w = big(vector.w)
    const a = createSpake2Party('A', w, vector.A, vector.B, big(vector.x))
    const b = createSpake2Party('B', w, vector.A, vector.B, big(vector.y))
    expect(hex(a.message)).toBe(vector.pA)
    expect(hex(b.message)).toBe(vector.pB)

    const keysA = a.finish(b.message)
    const keysB = b.finish(a.message)
    expect(hex(keysA.Ke)).toBe(vector.Ke)
    expect(hex(keysB.Ke)).toBe(vector.Ke)
    expect(hex(keysA.confirmation)).toBe(vector.confA)
    expect(hex(keysB.confirmation)).toBe(vector.confB)
    expect(keysA.verifyPeer(keysB.confirmation)).toBe(true)
    expect(keysB.verifyPeer(keysA.confirmation)).toBe(true)
  })

  it('agrees on a key when both sides typed the same code', () => {
    const w = passwordScalar('4821', 'salt')
    const a = createSpake2Party('A', w, 'client', 'host')
    const b = createSpake2Party('B', w, 'client', 'host')
    const keysA = a.finish(b.message)
    const keysB = b.finish(a.message)
    expect(keysA.Ke.equals(keysB.Ke)).toBe(true)
    expect(keysB.verifyPeer(keysA.confirmation)).toBe(true)
  })

  it('fails confirmation on a wrong code', () => {
    const a = createSpake2Party('A', passwordScalar('4821', 'salt'), 'client', 'host')
    const b = createSpake2Party('B', passwordScalar('4822', 'salt'), 'client', 'host')
    const keysA = a.finish(b.message)
    const keysB = b.finish(a.message)
    expect(keysA.Ke.equals(keysB.Ke)).toBe(false)
    expect(keysA.verifyPeer(keysB.confirmation)).toBe(false)
    expect(keysB.verifyPeer(keysA.confirmation)).toBe(false)
  })

  it('fails confirmation when the two sides bind different identities', () => {
    const w = passwordScalar('4821', 'salt')
    const a = createSpake2Party('A', w, 'client', 'host:fingerprint-seen-by-client')
    const b = createSpake2Party('B', w, 'client', 'host:real-fingerprint')
    expect(a.finish(b.message).verifyPeer(b.finish(a.message).confirmation)).toBe(false)
  })

  it('rejects a share that is not a curve point', () => {
    const a = createSpake2Party('A', passwordScalar('1', 's'), 'client', 'host')
    const bogus = Buffer.concat([Buffer.from([4]), crypto.randomBytes(64)])
    expect(() => a.finish(bogus)).toThrow()
  })

  it('hashes different salts to different scalars', () => {
    expect(passwordScalar('4821', 'a')).not.toBe(passwordScalar('4821', 'b'))
  })
})
