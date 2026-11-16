import type { ThemeToken } from '@/lib/builtInThemes'
import { hexChannels, type HexColor, type HexThemeColors } from '@/lib/themeColors'

// Below every Built-in Theme pair (lowest: 2.86:1), so no shipped theme needs an exception.
export const MIN_CONTRAST_RATIO = 2

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

/** The way back to a known theme: a draft failing one of these is held and cannot be saved. */
export const blockingPairs = [
  { text: 'foreground', background: 'background' },
  { text: 'popover-foreground', background: 'popover' },
] as const satisfies readonly TokenPair[]

export type BlockingPair = (typeof blockingPairs)[number]

export type UnreadablePair = BlockingPair & { ratio: number }

/** The first blocking pair below the minimum contrast, or null. */
export function findUnreadablePair(colors: HexThemeColors): UnreadablePair | null {
  for (const pair of blockingPairs) {
    const ratio = contrastRatio(colors[pair.text], colors[pair.background])
    if (ratio < MIN_CONTRAST_RATIO) return { ...pair, ratio }
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
