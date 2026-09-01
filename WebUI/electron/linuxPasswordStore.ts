import { execFileSync } from 'node:child_process'

/** Chromium DE names that select gnome-libsecret (Electron safeStorage docs). */
const GNOME_LIBSECRET_DESKTOPS = new Set([
  'x-cinnamon',
  'deepin',
  'gnome',
  'pantheon',
  'xfce',
  'ukui',
  'unity',
])

export function xdgDesktopSelectsGnomeLibsecret(xdgCurrentDesktop: string | undefined): boolean {
  return (xdgCurrentDesktop ?? '')
    .split(':')
    .map((part) => part.trim().toLowerCase())
    .some((part) => GNOME_LIBSECRET_DESKTOPS.has(part))
}

/**
 * Chromium picks gnome_libsecret from XDG_CURRENT_DESKTOP even when no keyring
 * daemon is running. safeStorage.setUsePlainTextEncryption cannot override that
 * already-resolved backend — encryptString then throws. --password-store=basic
 * must be set before app.whenReady() so Chromium selects BASIC_TEXT instead.
 */
export function shouldForceBasicPasswordStore(input: {
  platform: string
  xdgCurrentDesktop?: string
  secretServiceAvailable: boolean
  passwordStoreAlreadySet: boolean
}): boolean {
  if (input.platform !== 'linux' || input.passwordStoreAlreadySet) return false
  return xdgDesktopSelectsGnomeLibsecret(input.xdgCurrentDesktop) && !input.secretServiceAvailable
}

/** gdbus `(true,)` / `(false,)` or busctl `b true` / `b false`. */
export function parseNameHasOwnerReply(stdout: string): boolean {
  const text = stdout.trim()
  return /^\(\s*true\b/i.test(text) || /^b\s+true\b/i.test(text)
}

/** Opt-in is button 0; decline / Esc is 1 and is the default. */
export const INSECURE_STORAGE_DIALOG = {
  type: 'warning' as const,
  buttons: ['Use unencrypted storage', "Don't store secrets"],
  defaultId: 1,
  cancelId: 1,
  noLink: true,
  title: 'Unencrypted secret storage',
  message: 'No OS keyring is available on this system.',
  detail:
    'Home Agent channel passwords and cloud API keys would be obfuscated on disk, not encrypted.\n\n' +
    'Install and run a keyring daemon (GNOME Keyring or KWallet) for encrypted storage.\n\n' +
    'Continue only if you accept that these secrets are not protected.',
}

type EnvLike = { readonly [key: string]: string | undefined }

export function plaintextStorageEnvOverride(env: EnvLike = process.env): boolean | undefined {
  const raw = env.AIPG_ALLOW_PLAINTEXT_STORAGE?.trim().toLowerCase()
  if (raw === '1' || raw === 'true' || raw === 'yes') return true
  if (raw === '0' || raw === 'false' || raw === 'no') return false
  return undefined
}

/** True when the user (or AIPG_ALLOW_PLAINTEXT_STORAGE) opted into obfuscated storage. */
export async function confirmInsecureSecretStorage(opts: {
  env?: EnvLike
  askUser: () => Promise<number>
}): Promise<boolean> {
  const override = plaintextStorageEnvOverride(opts.env)
  if (override !== undefined) return override
  return (await opts.askUser()) === 0
}

/**
 * True when org.freedesktop.secrets is already on the session bus.
 * Uses NameHasOwner so we do not D-Bus-activate gnome-keyring-daemon
 * (Ping against the secrets dest would start it and false-positive).
 */
export function probeFreedesktopSecretService(): boolean {
  const attempts: Array<[string, string[]]> = [
    [
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.DBus',
        '--object-path',
        '/org/freedesktop/DBus',
        '--method',
        'org.freedesktop.DBus.NameHasOwner',
        'org.freedesktop.secrets',
      ],
    ],
    [
      'busctl',
      [
        '--user',
        'call',
        'org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus',
        'NameHasOwner',
        's',
        'org.freedesktop.secrets',
      ],
    ],
  ]
  for (const [cmd, args] of attempts) {
    try {
      const out = execFileSync(cmd, args, {
        timeout: 800,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      return parseNameHasOwnerReply(out)
    } catch {
      continue
    }
  }
  return false
}
