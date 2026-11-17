import type { ThemeToken } from '@/lib/builtInThemes'
import { hexChannels, type HexColor, type HexThemeColors } from '@/lib/themeColors'

// Below every Built-in Theme pair (lowest: 2.86:1), so no shipped theme needs an exception.
export const MIN_CONTRAST_RATIO = 2

// Below this the Way Back can no longer be found; anything above it is the user's call.
export const UNREADABLE_CONTRAST_RATIO = 1.1

const channelLuminance = (value: number) =>
  value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4

/** WCAG relative luminance of a `#rrggbb` colour, 0 (black) to 1 (white). */
export function relativeLuminance(hex: HexColor): number {
  const [r, g, b] = hexChannels(hex).map((c) => channelLuminance(c / 255))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

/** WCAG contrast ratio of two `#rrggbb` colours, 1 to 21, order-independent. */
export function contrastRatio(a: HexColor, b: HexColor): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x)
  return (lighter + 0.05) / (darker + 0.05)
}

export type TokenPair = { text: ThemeToken; background: ThemeToken }

/** The Way Back's menu: its items, and the highlighted one. A draft failing one is held. */
export const wayBackPairs = [
  { text: 'popover-foreground', background: 'popover' },
  { text: 'accent-foreground', background: 'accent' },
] as const satisfies readonly TokenPair[]

export type WayBackPair = (typeof wayBackPairs)[number]

export type UnreadablePair = WayBackPair & { ratio: number }

export function findUnreadablePair(colors: HexThemeColors): UnreadablePair | null {
  for (const pair of wayBackPairs) {
    const ratio = contrastRatio(colors[pair.text], colors[pair.background])
    if (ratio < UNREADABLE_CONTRAST_RATIO) return { ...pair, ratio }
  }
  return null
}

/** Rounded down, so a pair just below the minimum never displays as reaching it. */
export const formatContrastRatio = (ratio: number) => (Math.floor(ratio * 100) / 100).toFixed(2)

export type TextChoice = 'white' | 'black'

export const textChoiceHex: Record<TextChoice, HexColor> = { white: '#ffffff', black: '#000000' }

/** White or black, whichever reads better on `surface`. */
export const readableTextOn = (surface: HexColor): TextChoice =>
  contrastRatio(textChoiceHex.white, surface) >= contrastRatio(textChoiceHex.black, surface)
    ? 'white'
    : 'black'

const toHex = (channels: number[]): HexColor =>
  `#${channels.map((c) => Math.round(c).toString(16).padStart(2, '0')).join('')}`

export const compositeOver = (top: HexColor, alpha: number, bottom: HexColor): HexColor => {
  const under = hexChannels(bottom)
  return toHex(hexChannels(top).map((c, i) => c * alpha + under[i] * (1 - alpha)))
}

// Of the header's classes in App.vue only Light's `bg-muted/50` changes what Background shows.
const headerSurface = (colors: HexThemeColors, baseTheme: Theme | null): HexColor =>
  baseTheme === 'light' ? compositeOver(colors.muted, 0.5, colors.background) : colors.background

export type ThemeButtonColor = 'text' | TextChoice

export function themeButtonColorOn(
  colors: HexThemeColors,
  baseTheme: Theme | null,
): ThemeButtonColor {
  const surface = headerSurface(colors, baseTheme)
  return contrastRatio(colors.foreground, surface) >= UNREADABLE_CONTRAST_RATIO
    ? 'text'
    : readableTextOn(surface)
}
