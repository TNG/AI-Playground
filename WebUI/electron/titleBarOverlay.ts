export const TITLE_BAR_HEIGHT = 58
export const OVERLAY_COLOR_TRANSPARENT = '#00000000'

type Hsl = readonly [number, number, number]

const OVERLAY_SYMBOL_HSL: Record<Theme, Hsl> = {
  light: [222.2, 47.4, 11.2],
  dark: [280, 5, 90],
  lnl: [209, 5, 95],
  bmg: [280, 5, 90],
}

export type TitleBarOverlayOptions = {
  color: string
  symbolColor: string
  height: number
}

export function hslToHex(h: number, sPercent: number, lPercent: number): string {
  const s = sPercent / 100
  const l = lPercent / 100
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h / 30) % 12
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1)
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${f(0)}${f(8)}${f(4)}`
}

export function titleBarOverlayForTheme(theme: Theme): TitleBarOverlayOptions {
  return {
    // Header is translucent over themed wallpaper/pattern; an opaque overlay cannot match it.
    color: OVERLAY_COLOR_TRANSPARENT,
    symbolColor: hslToHex(...OVERLAY_SYMBOL_HSL[theme]),
    height: TITLE_BAR_HEIGHT,
  }
}

export function usesNativeWindowControls(platform: NodeJS.Platform): boolean {
  return platform === 'win32'
}

export function mainWindowChromeOptions(
  platform: NodeJS.Platform,
  theme: Theme,
): {
  frame: false
  titleBarStyle?: 'hidden'
  titleBarOverlay?: TitleBarOverlayOptions
} {
  if (!usesNativeWindowControls(platform)) {
    return { frame: false }
  }
  // Snap layouts only appear over a native HTMAXBUTTON; titleBarOverlay provides it.
  return {
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayForTheme(theme),
  }
}
