import { builtInThemes, themeTokens, type ThemeToken } from '@/lib/builtInThemes'
import { hexChannels, toHexColors, type HexColor, type HexThemeColors } from '@/lib/themeColors'
import { contrastRatio } from '@/lib/themeContrast'

export const mainColorTokens = [
  'background',
  'card',
  'foreground',
  'primary',
  'primary-foreground',
] as const satisfies readonly ThemeToken[]

export type MainColorToken = (typeof mainColorTokens)[number]
export type MainColors = Record<MainColorToken, HexColor>

export const isMainColorToken = (token: ThemeToken): token is MainColorToken =>
  (mainColorTokens as readonly ThemeToken[]).includes(token)

export const derivedColorTokens = themeTokens.filter((t) => !isMainColorToken(t))

export const mainColorsOf = (colors: HexThemeColors): MainColors =>
  Object.fromEntries(mainColorTokens.map((t) => [t, colors[t]])) as MainColors

type Vec3 = [number, number, number]

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toGamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)

function hexToOklab(hex: HexColor): Vec3 {
  const [r, g, b] = hexChannels(hex).map((c) => toLinear(c / 255))
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ]
}

function oklabToHex([L, a, b]: Vec3): HexColor {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  const rgb = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
  const channel = (c: number) =>
    Math.round(Math.min(1, Math.max(0, toGamma(c))) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${rgb.map(channel).join('')}`
}

/** `amount` of the way from `from` to `to`, in OKLab. */
function mixOklab(from: HexColor, to: HexColor, amount: number): HexColor {
  const a = hexToOklab(from)
  const b = hexToOklab(to)
  return oklabToHex(a.map((v, i) => v + (b[i] - v) * amount) as Vec3)
}

type MixedToken = 'muted-foreground' | 'muted' | 'accent' | 'secondary' | 'border'

// How far each colour sits from Background towards Text, fitted per brightness: dark against
// Dark, Intel® Core™ Ultra and Intel® Arc™, light against Light.
const darkBackgroundMixes: Record<MixedToken, number> = {
  'muted-foreground': 0.7,
  muted: 0.084,
  accent: 0.084,
  secondary: 0.027,
  border: 0.171,
}

const lightBackgroundMixes: Record<MixedToken, number> = {
  'muted-foreground': 0.555,
  muted: 0.038,
  accent: 0.038,
  secondary: 0.038,
  border: 0.086,
}

const shades = (id: Theme) => {
  const colors = toHexColors(builtInThemes.find((t) => t.id === id)!.colors)
  return {
    destructive: colors.destructive,
    'destructive-foreground': colors['destructive-foreground'],
    warning: colors.warning,
    success: colors.success,
  }
}

const darkBackgroundShades = shades('dark')
const lightBackgroundShades = shades('light')

const isDarkBackground = (hex: HexColor) =>
  contrastRatio(hex, '#ffffff') > contrastRatio(hex, '#000000')

/** Every colour of a Simple-mode theme, worked out from its five Main Colours. */
export function deriveThemeColors(main: MainColors): HexThemeColors {
  const { background, foreground: text, primary } = main
  const dark = isDarkBackground(background)
  const amounts = dark ? darkBackgroundMixes : lightBackgroundMixes
  const mix = (token: MixedToken) => mixOklab(background, text, amounts[token])
  const border = mix('border')
  return {
    ...main,
    'card-foreground': text,
    popover: background,
    'popover-foreground': text,
    'secondary-foreground': text,
    'accent-foreground': text,
    ring: primary,
    'muted-foreground': mix('muted-foreground'),
    muted: mix('muted'),
    accent: mix('accent'),
    secondary: mix('secondary'),
    border,
    input: border,
    ...(dark ? darkBackgroundShades : lightBackgroundShades),
  }
}
