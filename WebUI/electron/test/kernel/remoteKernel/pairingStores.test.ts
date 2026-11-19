import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import selfsigned from 'selfsigned'
import { createProtectedJsonFile } from '../../../persist/remoteKernelSecrets'
import {
  certificateFingerprint,
  createTlsIdentity,
  derToPem,
  type StoredIdentity,
} from '../../../kernel/remoteKernel/tlsIdentity'
import {
  createDeviceRegistry,
  openSealedToken,
  sealToken,
  type PairedDevice,
} from '../../../kernel/remoteKernel/pairing'

const plainCipher = {
  available: () => false,
  encrypt: (plain: string) => Buffer.from(plain),
  decrypt: (data: Buffer) => data.toString(),
}

function tempPath(name: string): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipg-pairing-')), name)
}

describe('remote-kernel stores', () => {
  it('keeps a TLS identity across restarts and replaces it on rotate', async () => {
    const file = tempPath('tls.json')
    const first = await createTlsIdentity(
      createProtectedJsonFile<StoredIdentity>(() => file, plainCipher),
      'test',
    ).current()
    const reloaded = createTlsIdentity(
      createProtectedJsonFile<StoredIdentity>(() => file, plainCipher),
      'test',
    )
    expect((await reloaded.current()).fingerprint).toBe(first.fingerprint)
    const rotated = await reloaded.rotate()
    expect(rotated.fingerprint).not.toBe(first.fingerprint)
    expect(new crypto.X509Certificate(rotated.certPem).publicKey.asymmetricKeyType).toBe('ec')
    // Electron's BoringSSL rejects a pinned self-signed root without the CA flag.
    expect(new crypto.X509Certificate(rotated.certPem).ca).toBe(true)
    expect(fs.statSync(file).mode & 0o077).toBe(0)
  })

  it('replaces a stored certificate that is not marked as a CA', async () => {
    const file = tempPath('tls.json')
    const store = createProtectedJsonFile<StoredIdentity>(() => file, plainCipher)
    const legacy = await selfsigned.generate([{ name: 'commonName', value: 'old' }], {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
    })
    store.write({ certPem: legacy.cert, keyPem: legacy.private })
    const current = await createTlsIdentity(store, 'test').current()
    expect(current.certPem).not.toBe(legacy.cert)
    expect(new crypto.X509Certificate(current.certPem).ca).toBe(true)
  })

  it('fingerprints a certificate the same from PEM and from the DER a TLS peer presents', async () => {
    const file = tempPath('tls.json')
    const { certPem, fingerprint } = await createTlsIdentity(
      createProtectedJsonFile<StoredIdentity>(() => file, plainCipher),
      'test',
    ).current()
    const der = new crypto.X509Certificate(certPem).raw
    expect(certificateFingerprint(der)).toBe(fingerprint)
    expect(certificateFingerprint(derToPem(der))).toBe(fingerprint)
  })

  it('stores encrypted when the cipher is available', () => {
    const file = tempPath('devices.json')
    const cipher = {
      available: () => true,
      encrypt: (plain: string) => Buffer.from(plain).reverse(),
      decrypt: (data: Buffer) => Buffer.from(data).reverse().toString(),
    }
    const store = createProtectedJsonFile<{ a: number }>(() => file, cipher)
    store.write({ a: 1 })
    expect(fs.readFileSync(file, 'utf8')).not.toContain('"a"')
    expect(store.read()).toEqual({ a: 1 })
  })

  it('keeps only token hashes and authenticates by token', () => {
    const file = tempPath('devices.json')
    const registry = createDeviceRegistry(
      createProtectedJsonFile<PairedDevice[]>(() => file, plainCipher),
    )
    const token = registry.add('device-1', 'laptop')
    expect(fs.readFileSync(file, 'utf8')).not.toContain(token)
    expect(registry.authenticate(token)?.name).toBe('laptop')
    expect(registry.authenticate('nope')).toBeNull()
    expect(registry.revoke('device-1')).toBe(true)
    expect(registry.authenticate(token)).toBeNull()
  })

  it('re-pairing a device replaces its old token', () => {
    const file = tempPath('devices.json')
    const registry = createDeviceRegistry(
      createProtectedJsonFile<PairedDevice[]>(() => file, plainCipher),
    )
    const first = registry.add('device-1', 'laptop')
    const second = registry.add('device-1', 'laptop')
    expect(registry.list()).toHaveLength(1)
    expect(registry.authenticate(first)).toBeNull()
    expect(registry.authenticate(second)?.id).toBe('device-1')
  })

  it('seals a token so only the holder of Ke opens it', () => {
    const key = crypto.randomBytes(16)
    const sealed = sealToken(key, 'secret-token')
    expect(openSealedToken(key, sealed)).toBe('secret-token')
    expect(() => openSealedToken(crypto.randomBytes(16), sealed)).toThrow()
  })
})
