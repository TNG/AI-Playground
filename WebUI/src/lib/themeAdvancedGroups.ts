import type { ThemeToken } from '@/lib/builtInThemes'
import type { HexThemeColors } from '@/lib/themeColors'
import { contrastRatio, MIN_CONTRAST_RATIO } from '@/lib/themeContrast'

export type AdvancedSample =
  'text' | 'menu-row' | 'focused-field' | 'line' | 'badge' | 'notice' | 'tick'

/** One Advanced row: a surface and the text on it, or a single colour measured on `contrastOn`. */
export type AdvancedRow = {
  surface: ThemeToken
  text?: ThemeToken
  contrastOn?: ThemeToken
  sample: AdvancedSample
}

export type AdvancedGroupId = 'base' | 'accent' | 'subtle' | 'lines' | 'danger' | 'status'

export type AdvancedGroup = { id: AdvancedGroupId; rows: AdvancedRow[] }

export const advancedGroups: readonly AdvancedGroup[] = [
  {
    id: 'base',
    rows: [
      { surface: 'background', text: 'foreground', sample: 'text' },
      { surface: 'card', text: 'card-foreground', sample: 'text' },
      { surface: 'popover', text: 'popover-foreground', sample: 'text' },
    ],
  },
  {
    id: 'accent',
    rows: [
      { surface: 'primary', text: 'primary-foreground', sample: 'text' },
      { surface: 'ring', sample: 'focused-field' },
    ],
  },
  {
    id: 'subtle',
    rows: [
      { surface: 'muted', text: 'muted-foreground', sample: 'text' },
      { surface: 'secondary', text: 'secondary-foreground', sample: 'text' },
      { surface: 'accent', text: 'accent-foreground', sample: 'menu-row' },
    ],
  },
  {
    id: 'lines',
    rows: [
      { surface: 'border', sample: 'line' },
      { surface: 'input', sample: 'line' },
    ],
  },
  {
    id: 'danger',
    rows: [{ surface: 'destructive', text: 'destructive-foreground', sample: 'badge' }],
  },
  {
    id: 'status',
    rows: [
      { surface: 'warning', contrastOn: 'background', sample: 'notice' },
      { surface: 'success', contrastOn: 'background', sample: 'tick' },
    ],
  },
]

export const groupLabelKeys: Record<AdvancedGroupId, string> = {
  base: 'SETTINGS_THEME_GROUP_BASE',
  accent: 'SETTINGS_THEME_GROUP_ACCENT',
  subtle: 'SETTINGS_THEME_GROUP_SUBTLE',
  lines: 'SETTINGS_THEME_GROUP_LINES',
  danger: 'SETTINGS_THEME_GROUP_DANGER',
  status: 'SETTINGS_THEME_GROUP_STATUS',
}

/** Each colour's readable name, shared by Advanced mode and the Simple-mode confirmation. */
export const colorLabelKeys: Record<ThemeToken, string> = {
  background: 'SETTINGS_THEME_MAIN_BACKGROUND',
  foreground: 'SETTINGS_THEME_MAIN_TEXT',
  card: 'SETTINGS_THEME_MAIN_PANELS',
  'card-foreground': 'SETTINGS_THEME_COLOR_PANEL_TEXT',
  popover: 'SETTINGS_THEME_COLOR_POPOVER',
  'popover-foreground': 'SETTINGS_THEME_COLOR_POPOVER_TEXT',
  primary: 'SETTINGS_THEME_MAIN_ACCENT',
  'primary-foreground': 'SETTINGS_THEME_MAIN_ACCENT_TEXT',
  ring: 'SETTINGS_THEME_COLOR_RING',
  muted: 'SETTINGS_THEME_COLOR_MUTED',
  'muted-foreground': 'SETTINGS_THEME_COLOR_MUTED_TEXT',
  secondary: 'SETTINGS_THEME_COLOR_SECONDARY',
  'secondary-foreground': 'SETTINGS_THEME_COLOR_SECONDARY_TEXT',
  accent: 'SETTINGS_THEME_COLOR_HOVER',
  'accent-foreground': 'SETTINGS_THEME_COLOR_HOVER_TEXT',
  border: 'SETTINGS_THEME_COLOR_BORDER',
  input: 'SETTINGS_THEME_COLOR_INPUT',
  destructive: 'SETTINGS_THEME_COLOR_DANGER',
  'destructive-foreground': 'SETTINGS_THEME_COLOR_DANGER_TEXT',
  warning: 'SETTINGS_THEME_COLOR_WARNING',
  success: 'SETTINGS_THEME_COLOR_SUCCESS',
}

/** Rounded down, so a pair just below the minimum never displays as reaching it. */
export const formatContrastRatio = (ratio: number) => (Math.floor(ratio * 100) / 100).toFixed(2)

export type AdvancedRowContrast = { ratio: number; readable: boolean }

/** The row's contrast against what it sits on, or null for a colour with no such pair. */
export function advancedRowContrast(
  row: AdvancedRow,
  colors: HexThemeColors,
): AdvancedRowContrast | null {
  const [fore, back] = row.text
    ? [row.text, row.surface]
    : row.contrastOn
      ? [row.surface, row.contrastOn]
      : []
  if (!fore || !back) return null
  const ratio = contrastRatio(colors[fore], colors[back])
  return { ratio, readable: ratio >= MIN_CONTRAST_RATIO }
}
