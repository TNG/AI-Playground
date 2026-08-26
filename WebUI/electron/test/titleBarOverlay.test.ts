import { describe, expect, it } from 'vitest'
import {
  TITLE_BAR_HEIGHT,
  hslToHex,
  mainWindowChromeOptions,
  titleBarOverlayForTheme,
  usesNativeWindowControls,
} from '../titleBarOverlay'

const HEX = /^#[0-9a-f]{6}$/

describe('hslToHex', () => {
  it('converts primary colors and greyscale', () => {
    expect(hslToHex(0, 0, 100)).toBe('#ffffff')
    expect(hslToHex(0, 0, 0)).toBe('#000000')
    expect(hslToHex(0, 100, 50)).toBe('#ff0000')
    expect(hslToHex(120, 100, 50)).toBe('#00ff00')
    expect(hslToHex(240, 100, 50)).toBe('#0000ff')
  })
})

describe('titleBarOverlayForTheme', () => {
  it('sizes the overlay to the custom header', () => {
    for (const theme of ['dark', 'lnl', 'bmg', 'light'] as const) {
      const overlay = titleBarOverlayForTheme(theme)
      expect(overlay.height).toBe(TITLE_BAR_HEIGHT)
      expect(overlay.color).toMatch(HEX)
      expect(overlay.symbolColor).toMatch(HEX)
    }
  })

  it('uses dark symbols on the light theme and light symbols on dark themes', () => {
    expect(luminance(titleBarOverlayForTheme('light').symbolColor)).toBeLessThan(
      luminance(titleBarOverlayForTheme('light').color),
    )
    for (const theme of ['dark', 'lnl', 'bmg'] as const) {
      expect(luminance(titleBarOverlayForTheme(theme).symbolColor)).toBeGreaterThan(
        luminance(titleBarOverlayForTheme(theme).color),
      )
    }
  })
})

describe('mainWindowChromeOptions', () => {
  it('exposes a native maximize hit target on Windows', () => {
    const chrome = mainWindowChromeOptions('win32', 'bmg')
    expect(chrome.frame).toBe(false)
    expect(chrome.titleBarStyle).toBe('hidden')
    expect(chrome.titleBarOverlay).toEqual(titleBarOverlayForTheme('bmg'))
  })

  it('keeps a fully custom title bar on macOS and Linux', () => {
    expect(mainWindowChromeOptions('linux', 'bmg')).toEqual({ frame: false })
    expect(mainWindowChromeOptions('darwin', 'light')).toEqual({ frame: false })
  })
})

describe('usesNativeWindowControls', () => {
  it('is Windows-only', () => {
    expect(usesNativeWindowControls('win32')).toBe(true)
    expect(usesNativeWindowControls('linux')).toBe(false)
    expect(usesNativeWindowControls('darwin')).toBe(false)
  })
})

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16)
  const r = (n >> 16) & 255
  const g = (n >> 8) & 255
  const b = n & 255
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
