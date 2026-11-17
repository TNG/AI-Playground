import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { builtInThemes, themeTokens } from '@/lib/builtInThemes'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const webUiDir = path.resolve(__dirname, '../../..')
const srcDir = path.join(webUiDir, 'src')
const stylesheet = readFileSync(path.join(srcDir, 'assets/css/index.css'), 'utf8')

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

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sourceFiles(full)
    return /\.(vue|ts|tsx|js|css)$/.test(entry.name) ? [full] : []
  })
}

const darkClass = /(?<![\w-])dark:(?=[\w[!&-])/

describe('no dark variant', () => {
  it('declares no Tailwind dark variant', () => {
    expect(stylesheet).not.toMatch(/@custom-variant\s+dark\b/)
    const tailwindConfig = readFileSync(path.join(webUiDir, 'tailwind.config.cjs'), 'utf8')
    expect(tailwindConfig).not.toMatch(/\bdarkMode\b/)
  })

  it('matches dark: classes but not object keys', () => {
    expect('text-red-500 dark:text-red-900').toMatch(darkClass)
    expect('dark:bg-[var(--x)]').toMatch(darkClass)
    expect("dark: '.dark'").not.toMatch(darkClass)
  })

  it('uses no dark: class in the renderer source', () => {
    const offenders = sourceFiles(srcDir).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          darkClass.test(line) ? [`${path.relative(srcDir, file)}:${i + 1}`] : [],
        ),
    )
    expect(offenders, 'Use theme tokens instead of dark: classes').toEqual([])
  })
})

const fixedStatusColor = /\b(text|bg|border|ring)-(amber|yellow|green|emerald)-\d{2,3}\b/

// A fixed console palette, and a channel's identity colour beside Telegram's brand blue.
const fixedPaletteFiles = [
  'components/ErrorDetailsModal.vue',
  'assets/js/store/channels/channelRegistry.ts',
]

describe('status colours', () => {
  it('uses Warning and Success instead of fixed amber, yellow, green or emerald', () => {
    const offenders = sourceFiles(srcDir)
      .filter(
        (file) =>
          !fixedPaletteFiles.includes(path.relative(srcDir, file).split(path.sep).join('/')),
      )
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .flatMap((line, i) =>
            fixedStatusColor.test(line) ? [`${path.relative(srcDir, file)}:${i + 1}`] : [],
          ),
      )
    expect(offenders, 'Use text-warning / text-success').toEqual([])
  })
})
