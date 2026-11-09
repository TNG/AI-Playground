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

export const corePairs = [
  { text: 'foreground', background: 'background' },
  { text: 'card-foreground', background: 'card' },
  { text: 'popover-foreground', background: 'popover' },
  { text: 'primary-foreground', background: 'primary' },
  { text: 'muted-foreground', background: 'background' },
] as const satisfies readonly TokenPair[]

export type CorePair = (typeof corePairs)[number]

export type UnreadablePair = CorePair & { ratio: number }

/** The first core pair below the minimum contrast, or null. */
export function findUnreadablePair(colors: HexThemeColors): UnreadablePair | null {
  for (const pair of corePairs) {
    const ratio = contrastRatio(colors[pair.text], colors[pair.background])
    if (ratio < MIN_CONTRAST_RATIO) return { ...pair, ratio }
  }
  return null
}
