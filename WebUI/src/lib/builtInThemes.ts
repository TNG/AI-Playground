export const themeTokens = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'border',
  'input',
  'ring',
] as const

export type ThemeToken = (typeof themeTokens)[number]

/** Space-separated HSL channels, read by the stylesheet as `hsl(var(--token))`. */
export type ThemeColors = Record<ThemeToken, string>

export type BuiltInTheme = {
  id: Theme
  name: string
  colors: ThemeColors
}

const purpleDark = {
  foreground: '280 5% 90%',
  'card-foreground': '280 5% 90%',
  'popover-foreground': '280 5% 90%',
  primary: '280 98.4% 50.6%',
  'primary-foreground': '0 0% 100%',
  secondary: '280 30% 10%',
  'secondary-foreground': '0 0% 100%',
  muted: '242 30% 15%',
  'muted-foreground': '280 5% 60%',
  accent: '242 30% 15%',
  'accent-foreground': '280 5% 90%',
  destructive: '0 100% 30%',
  'destructive-foreground': '280 5% 90%',
  border: '280 30% 18%',
  input: '280 30% 18%',
  ring: '280 98.4% 50.6%',
} satisfies Partial<ThemeColors>

export const builtInThemes: readonly BuiltInTheme[] = [
  {
    id: 'dark',
    name: 'Dark',
    colors: {
      ...purpleDark,
      background: '280 50% 5%',
      card: '280 50% 0%',
      popover: '280 50% 5%',
    },
  },
  {
    id: 'lnl',
    name: 'Intel® Core™ Ultra',
    colors: {
      background: '209 58% 10%',
      foreground: '209 5% 95%',
      card: '209 58% 8%',
      'card-foreground': '209 5% 95%',
      popover: '209 58% 10%',
      'popover-foreground': '209 5% 95%',
      primary: '209 100% 60%',
      'primary-foreground': '0 0% 100%',
      secondary: '209 40% 15%',
      'secondary-foreground': '0 0% 100%',
      muted: '209 30% 20%',
      'muted-foreground': '209 5% 70%',
      accent: '209 40% 20%',
      'accent-foreground': '209 5% 95%',
      destructive: '0 100% 30%',
      'destructive-foreground': '209 5% 95%',
      border: '209 30% 25%',
      input: '209 30% 25%',
      ring: '209 100% 60%',
    },
  },
  {
    id: 'bmg',
    name: 'Intel® Arc™',
    colors: {
      ...purpleDark,
      background: '280 50% 10%',
      card: '280 50% 3%',
      popover: '280 50% 5%',
    },
  },
  {
    id: 'light',
    name: 'Light',
    colors: {
      background: '0 0% 100%',
      foreground: '222.2 47.4% 11.2%',
      card: '0 0% 100%',
      'card-foreground': '222.2 47.4% 11.2%',
      popover: '0 0% 100%',
      'popover-foreground': '222.2 47.4% 11.2%',
      primary: '209 100% 60%',
      'primary-foreground': '0 0% 100%',
      secondary: '210 40% 96.1%',
      'secondary-foreground': '222.2 47.4% 11.2%',
      muted: '210 40% 96.1%',
      'muted-foreground': '215.4 16.3% 46.9%',
      accent: '210 40% 96.1%',
      'accent-foreground': '222.2 47.4% 11.2%',
      destructive: '0 84.2% 60.2%',
      'destructive-foreground': '0 0% 98%',
      border: '214.3 31.8% 91.4%',
      input: '214.3 31.8% 91.4%',
      ring: '209 100% 60%',
    },
  },
]

export const fallbackBuiltInTheme: BuiltInTheme = builtInThemes[3]
