import crypto from 'node:crypto'
import selfsigned from 'selfsigned'
import type { ProtectedJsonFile } from '../../persist/remoteKernelSecrets'

export type TlsIdentity = { certPem: string; keyPem: string; fingerprint: string }

export type StoredIdentity = { certPem: string; keyPem: string }

const VALIDITY_MS = 10 * 365 * 24 * 60 * 60 * 1000

/** SHA-256 over the certificate's DER, lowercase hex: what a client pins. */
export function certificateFingerprint(cert: string | Buffer): string {
  return new crypto.X509Certificate(cert).fingerprint256.replaceAll(':', '').toLowerCase()
}

export function derToPem(der: Buffer): string {
  const body =
    der
      .toString('base64')
      .match(/.{1,64}/g)
      ?.join('\n') ?? ''
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`
}

async function generate(commonName: string): Promise<StoredIdentity> {
  const result = await selfsigned.generate([{ name: 'commonName', value: commonName }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notAfterDate: new Date(Date.now() + VALIDITY_MS),
  })
  return { certPem: result.cert, keyPem: result.private }
}

/** The workstation's self-signed certificate, created on first use and kept until rotated. */
export function createTlsIdentity(file: ProtectedJsonFile<StoredIdentity>, commonName: string) {
  let cached: TlsIdentity | null = null

  function remember(stored: StoredIdentity): TlsIdentity {
    cached = { ...stored, fingerprint: certificateFingerprint(stored.certPem) }
    return cached
  }

  async function rotate(): Promise<TlsIdentity> {
    const stored = await generate(commonName)
    file.write(stored)
    return remember(stored)
  }

  return {
    current: async (): Promise<TlsIdentity> => {
      if (cached) return cached
      const stored = file.read()
      return stored ? remember(stored) : rotate()
    },
    rotate,
  }
}

export type TlsIdentityStore = ReturnType<typeof createTlsIdentity>
