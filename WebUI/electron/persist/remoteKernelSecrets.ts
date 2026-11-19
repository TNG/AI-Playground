import fs from 'node:fs'
import path from 'node:path'

export type SecretCipher = {
  available: () => boolean
  encrypt: (plain: string) => Buffer
  decrypt: (data: Buffer) => string
}

type StoredValue = { encoding: 'safeStorage' | 'plain'; data: string }

export type ProtectedJsonFile<T> = {
  read: () => T | null
  write: (value: T) => void
  remove: () => void
}

/**
 * One JSON value in userData, encrypted with safeStorage when the OS offers it; on a Linux box
 * with no keyring it falls back to an owner-only plaintext file. Remote-kernel state uses one
 * file per concern: the workstation's TLS key, its paired devices, the client's paired host.
 */
export function createProtectedJsonFile<T>(
  filePath: () => string,
  cipher: SecretCipher,
): ProtectedJsonFile<T> {
  return {
    read: () => {
      try {
        const stored = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as StoredValue
        const text =
          stored.encoding === 'safeStorage'
            ? cipher.decrypt(Buffer.from(stored.data, 'base64'))
            : stored.data
        return JSON.parse(text) as T
      } catch {
        return null
      }
    },
    write: (value) => {
      const text = JSON.stringify(value)
      const stored: StoredValue = cipher.available()
        ? { encoding: 'safeStorage', data: cipher.encrypt(text).toString('base64') }
        : { encoding: 'plain', data: text }
      fs.mkdirSync(path.dirname(filePath()), { recursive: true })
      fs.writeFileSync(filePath(), JSON.stringify(stored), { encoding: 'utf8', mode: 0o600 })
      fs.chmodSync(filePath(), 0o600)
    },
    remove: () => fs.rmSync(filePath(), { force: true }),
  }
}
