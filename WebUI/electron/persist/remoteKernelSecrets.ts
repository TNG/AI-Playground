import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export type RemoteKernelSecretKey = 'hostToken' | 'clientToken'

export type SecretCipher = {
  available: () => boolean
  encrypt: (plain: string) => Buffer
  decrypt: (data: Buffer) => string
}

type StoredSecret = { encoding: 'safeStorage' | 'plain'; data: string }
type SecretsFile = Partial<Record<RemoteKernelSecretKey, StoredSecret>>

export type RemoteKernelSecrets = {
  read: (key: RemoteKernelSecretKey) => string | null
  write: (key: RemoteKernelSecretKey, value: string) => void
  /** The host token, minted on first use. */
  hostToken: () => string
  regenerateHostToken: () => string
}

export function mintRemoteKernelToken(): string {
  return randomBytes(24).toString('base64url')
}

/**
 * Remote-kernel tokens in userData. Encrypted with safeStorage when the OS offers it;
 * on a Linux box with no keyring they fall back to an owner-only plaintext file.
 */
export function createRemoteKernelSecrets(
  filePath: () => string,
  cipher: SecretCipher,
): RemoteKernelSecrets {
  function load(): SecretsFile {
    try {
      return JSON.parse(fs.readFileSync(filePath(), 'utf8')) as SecretsFile
    } catch {
      return {}
    }
  }

  function read(key: RemoteKernelSecretKey): string | null {
    const stored = load()[key]
    if (!stored) return null
    try {
      return stored.encoding === 'safeStorage'
        ? cipher.decrypt(Buffer.from(stored.data, 'base64'))
        : stored.data
    } catch {
      return null
    }
  }

  function write(key: RemoteKernelSecretKey, value: string): void {
    const encrypted = cipher.available()
    const next: SecretsFile = {
      ...load(),
      [key]: encrypted
        ? { encoding: 'safeStorage', data: cipher.encrypt(value).toString('base64') }
        : { encoding: 'plain', data: value },
    }
    fs.mkdirSync(path.dirname(filePath()), { recursive: true })
    fs.writeFileSync(filePath(), JSON.stringify(next), { encoding: 'utf8', mode: 0o600 })
  }

  function regenerateHostToken(): string {
    const token = mintRemoteKernelToken()
    write('hostToken', token)
    return token
  }

  return {
    read,
    write,
    hostToken: () => read('hostToken') ?? regenerateHostToken(),
    regenerateHostToken,
  }
}
