export const TITLE_BAR_HEIGHT = 58

type Hsl = readonly [number, number, number]

// Header composites to --background; --muted on light was a visible grey-blue block.
const OVERLAY_HSL: Record<Theme, { color: Hsl; symbolColor: Hsl }> = {
  light: { color: [0, 0, 100], symbolColor: [222.2, 47.4, 11.2] },
  dark: { color: [280, 50, 5], symbolColor: [280, 5, 90] },
  lnl: { color: [209, 58, 10], symbolColor: [209, 5, 95] },
  bmg: { color: [280, 50, 10], symbolColor: [280, 5, 90] },
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
  const { color, symbolColor } = OVERLAY_HSL[theme]
  return {
    color: hslToHex(...color),
    symbolColor: hslToHex(...symbolColor),
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
