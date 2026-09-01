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

/** True when org.freedesktop.secrets is actually on the session bus. */
export function probeFreedesktopSecretService(): boolean {
  const attempts: Array<[string, string[]]> = [
    ['busctl', ['--user', 'status', 'org.freedesktop.secrets']],
    [
      'gdbus',
      [
        'call',
        '--session',
        '--dest',
        'org.freedesktop.secrets',
        '--object-path',
        '/org/freedesktop/secrets',
        '--method',
        'org.freedesktop.DBus.Peer.Ping',
      ],
    ],
  ]
  for (const [cmd, args] of attempts) {
    try {
      execFileSync(cmd, args, { timeout: 800, stdio: 'ignore' })
      return true
    } catch {
      continue
    }
  }
  return false
}
