const PREFIX = 'pbkdf2$'
const BASE64 = '[A-Za-z0-9+/]+={0,2}'
const ITERATIONS_TEXT = '[1-9]\\d{0,7}'

/** The stored form: `pbkdf2$<iterations>$<salt>$<hash>`. */
export const HASHED_DEMO_PASSCODE = new RegExp(
  `^pbkdf2\\$${ITERATIONS_TEXT}\\$${BASE64}\\$${BASE64}$`,
)

const BASE64_ONLY = new RegExp(`^${BASE64}$`)
const ITERATIONS_ONLY = new RegExp(`^${ITERATIONS_TEXT}$`)

export function isHashedDemoPasscode(value: string): boolean {
  return HASHED_DEMO_PASSCODE.test(value)
}
const ITERATIONS = 600_000
const SALT_BYTES = 16
const HASH_BITS = 256

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

function fromBase64(text: string): Uint8Array | null {
  if (!BASE64_ONLY.test(text)) return null
  try {
    return Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
}

async function derive(passcode: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(passcode),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations },
    key,
    HASH_BITS,
  )
  return new Uint8Array(bits)
}

export async function hashDemoPasscode(passcode: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const hash = await derive(passcode, salt, ITERATIONS)
  return `${PREFIX}${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`
}

export async function verifyDemoPasscode(input: string, stored: string): Promise<boolean> {
  if (!stored.startsWith(PREFIX)) return input === stored

  const parts = stored.slice(PREFIX.length).split('$')
  if (parts.length !== 3) return false
  const [iterationsText, saltText, hashText] = parts
  if (!ITERATIONS_ONLY.test(iterationsText)) return false
  const salt = fromBase64(saltText)
  const expected = fromBase64(hashText)
  if (!salt || !expected || expected.length * 8 !== HASH_BITS) return false

  const actual = await derive(input, salt, Number(iterationsText))
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i]
  return diff === 0
}
