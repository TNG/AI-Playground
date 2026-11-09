import type { ThemeColors, ThemeToken } from '@/lib/builtInThemes'

/** `#rrggbb`, no alpha: what the picker edits and the preferences file stores. */
export type HexColor = string
export type HexThemeColors = Record<ThemeToken, HexColor>

export const isHexColor = (value: unknown): value is HexColor =>
  typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value)

/** The red, green and blue channels of a `#rrggbb` colour, 0 to 255. */
export const hexChannels = (hex: HexColor): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16),
  parseInt(hex.slice(3, 5), 16),
  parseInt(hex.slice(5, 7), 16),
]

const round = (n: number, digits = 1) => Number(n.toFixed(digits))

export function hslTripletToHex(triplet: string): HexColor {
  const [h, s, l] = triplet.split(' ').map((part) => parseFloat(part))
  const sat = s / 100
  const light = l / 100
  const chroma = (1 - Math.abs(2 * light - 1)) * sat
  const channel = (n: number) => {
    const k = (n + h / 30) % 12
    const value = light - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

export function hexToHslTriplet(hex: HexColor): string {
  const [r, g, b] = hexChannels(hex).map((c) => c / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const light = (max + min) / 2
  const delta = max - min
  let hue = 0
  let sat = 0
  if (delta > 0) {
    sat = delta / (1 - Math.abs(2 * light - 1))
    if (max === r) hue = ((g - b) / delta) % 6
    else if (max === g) hue = (b - r) / delta + 2
    else hue = (r - g) / delta + 4
    hue = (hue * 60 + 360) % 360
  }
  return `${round(hue)} ${round(sat * 100)}% ${round(light * 100)}%`
}

const mapColors = <From, To>(
  colors: Record<ThemeToken, From>,
  convert: (value: From) => To,
): Record<ThemeToken, To> =>
  Object.fromEntries(Object.entries(colors).map(([k, v]) => [k, convert(v as From)])) as Record<
    ThemeToken,
    To
  >

export const toHexColors = (colors: ThemeColors): HexThemeColors =>
  mapColors(colors, hslTripletToHex)

export const toHslColors = (colors: HexThemeColors): ThemeColors =>
  mapColors(colors, hexToHslTriplet)
