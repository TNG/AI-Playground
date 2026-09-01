import { describe, it, expect, vi } from 'vitest'
import {
  confirmInsecureSecretStorage,
  INSECURE_STORAGE_DIALOG,
  parseNameHasOwnerReply,
  plaintextStorageEnvOverride,
  shouldForceBasicPasswordStore,
  xdgDesktopSelectsGnomeLibsecret,
} from '../linuxPasswordStore'

describe('xdgDesktopSelectsGnomeLibsecret', () => {
  it('matches GNOME-family desktops Chromium maps to gnome-libsecret', () => {
    expect(xdgDesktopSelectsGnomeLibsecret('GNOME')).toBe(true)
    expect(xdgDesktopSelectsGnomeLibsecret('ubuntu:GNOME')).toBe(true)
    expect(xdgDesktopSelectsGnomeLibsecret('XFCE')).toBe(true)
    expect(xdgDesktopSelectsGnomeLibsecret('X-Cinnamon')).toBe(true)
  })

  it('does not match KDE, unknown, or unset desktops', () => {
    expect(xdgDesktopSelectsGnomeLibsecret(undefined)).toBe(false)
    expect(xdgDesktopSelectsGnomeLibsecret('')).toBe(false)
    expect(xdgDesktopSelectsGnomeLibsecret('KDE')).toBe(false)
    expect(xdgDesktopSelectsGnomeLibsecret('Hyprland')).toBe(false)
  })
})

describe('shouldForceBasicPasswordStore', () => {
  const gnomeWithoutKeyring = {
    platform: 'linux',
    xdgCurrentDesktop: 'ubuntu:GNOME',
    secretServiceAvailable: false,
    passwordStoreAlreadySet: false,
  }

  it('forces basic when Chromium would pick gnome_libsecret with no daemon', () => {
    expect(shouldForceBasicPasswordStore(gnomeWithoutKeyring)).toBe(true)
  })

  it('leaves a working Secret Service on GNOME alone', () => {
    expect(
      shouldForceBasicPasswordStore({ ...gnomeWithoutKeyring, secretServiceAvailable: true }),
    ).toBe(false)
  })

  it('does not override an explicit --password-store', () => {
    expect(
      shouldForceBasicPasswordStore({ ...gnomeWithoutKeyring, passwordStoreAlreadySet: true }),
    ).toBe(false)
  })

  it('does not force basic on Windows or on a DE Chromium already maps to basic_text', () => {
    expect(shouldForceBasicPasswordStore({ ...gnomeWithoutKeyring, platform: 'win32' })).toBe(false)
    expect(
      shouldForceBasicPasswordStore({ ...gnomeWithoutKeyring, xdgCurrentDesktop: undefined }),
    ).toBe(false)
    expect(
      shouldForceBasicPasswordStore({ ...gnomeWithoutKeyring, xdgCurrentDesktop: 'KDE' }),
    ).toBe(false)
  })
})

describe('parseNameHasOwnerReply', () => {
  it('reads gdbus and busctl replies without treating a missing owner as present', () => {
    expect(parseNameHasOwnerReply('(true,)\n')).toBe(true)
    expect(parseNameHasOwnerReply('(false,)\n')).toBe(false)
    expect(parseNameHasOwnerReply('b true\n')).toBe(true)
    expect(parseNameHasOwnerReply('b false\n')).toBe(false)
    expect(parseNameHasOwnerReply('')).toBe(false)
  })
})

describe('confirmInsecureSecretStorage', () => {
  it('defaults the dialog to declining unencrypted storage', () => {
    expect(INSECURE_STORAGE_DIALOG.defaultId).toBe(1)
    expect(INSECURE_STORAGE_DIALOG.cancelId).toBe(1)
    expect(INSECURE_STORAGE_DIALOG.buttons[0]).toBe('Use unencrypted storage')
  })

  it('honours AIPG_ALLOW_PLAINTEXT_STORAGE without showing a dialog', async () => {
    const askUser = vi.fn(async () => 0)
    expect(
      await confirmInsecureSecretStorage({ env: { AIPG_ALLOW_PLAINTEXT_STORAGE: '1' }, askUser }),
    ).toBe(true)
    expect(
      await confirmInsecureSecretStorage({ env: { AIPG_ALLOW_PLAINTEXT_STORAGE: '0' }, askUser }),
    ).toBe(false)
    expect(askUser).not.toHaveBeenCalled()
    expect(plaintextStorageEnvOverride({})).toBeUndefined()
  })

  it('opts in only when the user picks the unencrypted-storage button', async () => {
    expect(await confirmInsecureSecretStorage({ askUser: async () => 0 })).toBe(true)
    expect(await confirmInsecureSecretStorage({ askUser: async () => 1 })).toBe(false)
  })
})
