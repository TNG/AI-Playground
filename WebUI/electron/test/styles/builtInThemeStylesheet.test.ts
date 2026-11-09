import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtInThemes, themeTokens } from '@/lib/builtInThemes'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const stylesheet = readFileSync(
  path.resolve(__dirname, '../../../src/assets/css/index.css'),
  'utf8',
)

const selectorFor: Record<Theme, string> = {
  light: ':root',
  dark: '.dark',
  lnl: '.lnl',
  bmg: '.bmg',
}

function tokenValues(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const block = stylesheet.match(new RegExp(`^\\s*${escaped} \\{([^}]*)\\}`, 'm'))?.[1] ?? ''
  const values: Record<string, string> = {}
  for (const [, name, value] of block.matchAll(/--([\w-]+):\s*([^;]+);/g))
    if ((themeTokens as readonly string[]).includes(name)) values[name] = value.trim()
  return values
}

describe('Built-in Theme stylesheet blocks', () => {
  it.each(builtInThemes.map((t) => [t.id, t] as const))(
    '%s sets exactly the typed constants',
    (id, theme) => {
      expect(tokenValues(selectorFor[id])).toEqual(theme.colors)
    },
  )
})
