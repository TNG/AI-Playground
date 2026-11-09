import type { ThemeToken } from '@/lib/builtInThemes'

export const colorRoles = ['background', 'panels', 'accent', 'accentText', 'text'] as const

export type ColorRole = (typeof colorRoles)[number]

const roleMappings: Record<ColorRole, readonly ThemeToken[]> = {
  background: ['background'],
  panels: ['card', 'popover'],
  accent: ['primary', 'ring'],
  accentText: ['primary-foreground'],
  text: ['foreground', 'card-foreground', 'popover-foreground', 'accent-foreground'],
}

/** Every token a role sets. */
export const roleTokens = (role: ColorRole): readonly ThemeToken[] => roleMappings[role]

/** The token whose value a role shows in the editor. */
export const roleToken = (role: ColorRole): ThemeToken => roleMappings[role][0]
