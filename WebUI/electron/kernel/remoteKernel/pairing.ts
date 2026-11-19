import crypto from 'node:crypto'
import type { ProtectedJsonFile } from '../../persist/remoteKernelSecrets'
import type { PairedDeviceInfo, PairingWindowInfo } from '@/types/remoteKernelIpc'
import { createSpake2Party, passwordScalar, type Spake2Keys } from './spake2'

export type PairedDevice = {
  id: string
  name: string
  tokenHash: string
  pairedAt: number
  lastSeenAt?: number
}

export type SealedToken = { iv: string; ciphertext: string; tag: string }

export const PAIRING_WINDOW_MS = 2 * 60 * 1000
export const PAIRING_ATTEMPTS = 5
const SESSION_TTL_MS = 30 * 1000

/** Both sides hash the code with the certificate the client actually sees. */
export function pairingSalt(fingerprint: string): string {
  return `aipg-remote-pair-v1:${fingerprint}`
}

export function clientIdentity(deviceId: string): string {
  return `aipg-client:${deviceId}`
}

export function hostIdentity(fingerprint: string): string {
  return `aipg-host:${fingerprint}`
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function sealToken(key: Buffer, token: string): SealedToken {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-128-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return {
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
  }
}

export function openSealedToken(key: Buffer, sealed: SealedToken): string {
  const decipher = crypto.createDecipheriv('aes-128-gcm', key, Buffer.from(sealed.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(sealed.tag, 'hex'))
  return Buffer.concat([
    decipher.update(Buffer.from(sealed.ciphertext, 'hex')),
    decipher.final(),
  ]).toString('utf8')
}

export type PairingError = Error & { status: number }

function pairingError(message: string, status: number): PairingError {
  return Object.assign(new Error(message), { status })
}

/** The workstation's paired devices; only token hashes are kept. */
export function createDeviceRegistry(file: ProtectedJsonFile<PairedDevice[]>) {
  let devices = file.read() ?? []
  const save = () => file.write(devices)

  return {
    list: (): PairedDeviceInfo[] =>
      devices.map(({ id, name, pairedAt, lastSeenAt }) => ({ id, name, pairedAt, lastSeenAt })),
    add(id: string, name: string): string {
      const token = crypto.randomBytes(32).toString('base64url')
      devices = [
        ...devices.filter((device) => device.id !== id),
        { id, name, tokenHash: hashToken(token), pairedAt: Date.now() },
      ]
      save()
      return token
    },
    authenticate(token: string | undefined): PairedDevice | null {
      if (!token) return null
      const hash = Buffer.from(hashToken(token), 'hex')
      return (
        devices.find((device) =>
          crypto.timingSafeEqual(Buffer.from(device.tokenHash, 'hex'), hash),
        ) ?? null
      )
    },
    touch(id: string): void {
      const device = devices.find((entry) => entry.id === id)
      if (!device) return
      device.lastSeenAt = Date.now()
    },
    persistLastSeen: save,
    revoke(id: string): boolean {
      const before = devices.length
      devices = devices.filter((device) => device.id !== id)
      if (devices.length === before) return false
      save()
      return true
    },
    clear(): void {
      devices = []
      save()
    },
  }
}

export type DeviceRegistry = ReturnType<typeof createDeviceRegistry>

type Session = {
  keys: Spake2Keys
  deviceId: string
  deviceName: string
  createdAt: number
}

type OpenWindow = {
  code: string
  w: bigint
  fingerprint: string
  expiresAt: number
  attemptsLeft: number
  timer: ReturnType<typeof setTimeout>
}

export type PairingDeps = {
  devices: DeviceRegistry
  fingerprint: () => Promise<string>
  /** Fires when a window opens or closes (the mDNS record and the settings UI follow it). */
  onChange: () => void
  now?: () => number
}

/**
 * The workstation's pairing window: a 4-digit code that lives for two minutes. Every started
 * SPAKE2 session spends one of five attempts, because the host's confirmation already tells the
 * peer whether its guess was right — a peer need not finish to learn the answer.
 */
export function createPairing(deps: PairingDeps) {
  const now = deps.now ?? Date.now
  const sessions = new Map<string, Session>()
  let window: OpenWindow | null = null

  function close(): void {
    if (!window) return
    clearTimeout(window.timer)
    window = null
    sessions.clear()
    deps.onChange()
  }

  function liveWindow(): OpenWindow {
    if (!window || now() > window.expiresAt) {
      close()
      throw pairingError('No pairing window is open', 403)
    }
    return window
  }

  function dropStaleSessions(): void {
    for (const [id, session] of sessions) {
      if (now() - session.createdAt > SESSION_TTL_MS) sessions.delete(id)
    }
  }

  return {
    async open(): Promise<PairingWindowInfo> {
      close()
      const fingerprint = await deps.fingerprint()
      const code = crypto.randomInt(0, 10_000).toString().padStart(4, '0')
      const expiresAt = now() + PAIRING_WINDOW_MS
      const timer = setTimeout(close, PAIRING_WINDOW_MS)
      timer.unref?.()
      window = {
        code,
        w: passwordScalar(code, pairingSalt(fingerprint)),
        fingerprint,
        expiresAt,
        attemptsLeft: PAIRING_ATTEMPTS,
        timer,
      }
      deps.onChange()
      return { code, expiresAt, attemptsLeft: PAIRING_ATTEMPTS }
    },

    close,

    state(): PairingWindowInfo | null {
      if (window && now() > window.expiresAt) close()
      return window
        ? { code: window.code, expiresAt: window.expiresAt, attemptsLeft: window.attemptsLeft }
        : null
    },

    isOpen(): boolean {
      return !!window && now() <= window.expiresAt
    },

    start(request: { deviceId: string; deviceName: string; pA: string }): {
      sessionId: string
      pB: string
      confirmB: string
    } {
      const open = liveWindow()
      dropStaleSessions()
      if (open.attemptsLeft <= 0) throw pairingError('No pairing attempts left', 403)
      if (!/^[\w-]{1,64}$/.test(request.deviceId)) throw pairingError('Bad device id', 400)
      open.attemptsLeft -= 1
      const party = createSpake2Party(
        'B',
        open.w,
        clientIdentity(request.deviceId),
        hostIdentity(open.fingerprint),
      )
      let keys: Spake2Keys
      try {
        keys = party.finish(Buffer.from(request.pA, 'hex'))
      } catch {
        throw pairingError('Bad pairing message', 400)
      }
      const sessionId = crypto.randomUUID()
      sessions.set(sessionId, {
        keys,
        deviceId: request.deviceId,
        deviceName: request.deviceName.slice(0, 64) || 'Thin client',
        createdAt: now(),
      })
      deps.onChange()
      return {
        sessionId,
        pB: party.message.toString('hex'),
        confirmB: keys.confirmation.toString('hex'),
      }
    },

    finish(request: { sessionId: string; confirmA: string }): {
      device: PairedDeviceInfo
      sealed: SealedToken
    } {
      const open = liveWindow()
      const session = sessions.get(request.sessionId)
      sessions.delete(request.sessionId)
      if (!session || now() - session.createdAt > SESSION_TTL_MS) {
        throw pairingError('Pairing session expired', 403)
      }
      if (!session.keys.verifyPeer(Buffer.from(request.confirmA, 'hex'))) {
        if (open.attemptsLeft <= 0 && sessions.size === 0) close()
        throw pairingError('Pairing code did not match', 403)
      }
      const token = deps.devices.add(session.deviceId, session.deviceName)
      close()
      return {
        device: { id: session.deviceId, name: session.deviceName, pairedAt: now() },
        sealed: sealToken(session.keys.Ke, token),
      }
    },
  }
}

export type Pairing = ReturnType<typeof createPairing>
