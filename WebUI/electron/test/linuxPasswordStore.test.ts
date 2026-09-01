import { describe, it, expect } from 'vitest'
import {
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
