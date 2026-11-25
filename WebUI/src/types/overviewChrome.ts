import { z } from 'zod'

// The Overview page's chrome: the only strings the renderer emits that are not
// Session data. The renderer resolves them from the app's locale files and ships
// them with the agent turn, because main reads no translations.

export const OVERVIEW_CHROME_KEYS = [
  'OVERVIEW_PAGE_TITLE',
  'OVERVIEW_OMITTED_NOTE',
  'OVERVIEW_BEHIND_NOTE',
] as const

export type OverviewChromeKey = (typeof OVERVIEW_CHROME_KEYS)[number]

const chromeStringsShape = Object.fromEntries(
  OVERVIEW_CHROME_KEYS.map((key) => [key, z.string().min(1)]),
) as Record<OverviewChromeKey, z.ZodString>

export const OverviewChromeSchema = z.object({
  locale: z.string().min(1),
  strings: z.object(chromeStringsShape),
})

export type OverviewChrome = z.infer<typeof OverviewChromeSchema>
