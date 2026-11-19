import crypto from 'node:crypto'
import { p256 } from '@noble/curves/nist.js'

// SPAKE2 (RFC 9382), ciphersuite SPAKE2-P256-SHA256-HKDF-HMAC, no AAD. Turns a short code both
// sides know into a shared key without the code crossing the wire: a peer that guesses wrong
// learns nothing that would let it test a second guess offline.

const Point = p256.Point
type CurvePoint = InstanceType<typeof Point>
const ORDER = Point.Fn.ORDER

const M = Point.fromHex('02886e2f97ace46e55ba9dd7242579f2993b64e16ef3dcab95afd497333d8fa12f')
const N = Point.fromHex('03d8bbd6c639c62937b04d997f38c3770719c629d7014d49a24b4f98baa1292b49')

export type Spake2Role = 'A' | 'B'

export type Spake2Keys = {
  /** The shared secret both sides end up with (16 bytes). */
  Ke: Buffer
  /** The MAC this side sends to prove it derived the same keys. */
  confirmation: Buffer
  /** Checks the peer's MAC in constant time. */
  verifyPeer: (confirmation: Buffer) => boolean
}

export type Spake2Party = {
  /** This side's public share (uncompressed point, 65 bytes). */
  message: Buffer
  finish: (peerMessage: Buffer) => Spake2Keys
}

function toBigInt(bytes: Buffer): bigint {
  return BigInt(`0x${bytes.toString('hex') || '0'}`)
}

function scalarBytes(value: bigint): Buffer {
  return Buffer.from(value.toString(16).padStart(64, '0'), 'hex')
}

function pointBytes(point: CurvePoint): Buffer {
  return Buffer.from(point.toBytes(false))
}

function lengthPrefixed(value: Buffer): Buffer {
  const length = Buffer.alloc(8)
  length.writeBigUInt64LE(BigInt(value.length))
  return Buffer.concat([length, value])
}

function randomScalar(): bigint {
  for (;;) {
    const candidate = toBigInt(crypto.randomBytes(32))
    if (candidate > 0n && candidate < ORDER) return candidate
  }
}

/** The password scalar `w`: a memory-hard hash of the code, reduced mod the group order. */
export function passwordScalar(code: string, salt: string): bigint {
  const hashed = crypto.scryptSync(code, salt, 64, { N: 1 << 15, r: 8, p: 1, maxmem: 64 << 20 })
  return toBigInt(hashed) % ORDER
}

export function createSpake2Party(
  role: Spake2Role,
  w: bigint,
  identityA: string,
  identityB: string,
  ephemeral: bigint = randomScalar(),
): Spake2Party {
  const ownBlind = role === 'A' ? M : N
  const peerBlind = role === 'A' ? N : M
  const share = Point.BASE.multiply(ephemeral).add(ownBlind.multiply(w))
  const message = pointBytes(share)

  return {
    message,
    finish: (peerMessage) => {
      const peer = Point.fromBytes(peerMessage)
      peer.assertValidity()
      if (peer.equals(Point.ZERO)) throw new Error('SPAKE2: peer share is the identity')
      const shared = peer.subtract(peerBlind.multiply(w)).multiply(ephemeral)
      if (shared.equals(Point.ZERO)) throw new Error('SPAKE2: shared point is the identity')

      const [pA, pB] = role === 'A' ? [message, peerMessage] : [peerMessage, message]
      const transcript = Buffer.concat([
        lengthPrefixed(Buffer.from(identityA)),
        lengthPrefixed(Buffer.from(identityB)),
        lengthPrefixed(pA),
        lengthPrefixed(pB),
        lengthPrefixed(pointBytes(shared)),
        lengthPrefixed(scalarBytes(w)),
      ])
      const hash = crypto.createHash('sha256').update(transcript).digest()
      const Ke = hash.subarray(0, 16)
      const Ka = hash.subarray(16)
      const confirmationKeys = Buffer.from(
        crypto.hkdfSync('sha256', Ka, Buffer.alloc(0), Buffer.from('ConfirmationKeys'), 32),
      )
      const KcA = confirmationKeys.subarray(0, 16)
      const KcB = confirmationKeys.subarray(16)
      const mac = (key: Buffer) => crypto.createHmac('sha256', key).update(transcript).digest()
      const own = mac(role === 'A' ? KcA : KcB)
      const expected = mac(role === 'A' ? KcB : KcA)
      return {
        Ke: Buffer.from(Ke),
        confirmation: own,
        verifyPeer: (confirmation) =>
          confirmation.length === expected.length && crypto.timingSafeEqual(confirmation, expected),
      }
    },
  }
}
