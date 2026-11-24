// The Overview page's chrome: the only strings the renderer emits that are not
// Session data. The renderer resolves them from the app's locale files and ships
// them with the agent turn, because main reads no translations.

export const OVERVIEW_CHROME_KEYS = [
  'OVERVIEW_PAGE_TITLE',
  'OVERVIEW_RANGE',
  'OVERVIEW_BY_DAY',
  'OVERVIEW_SESSIONS',
  'OVERVIEW_SESSION_META',
  'OVERVIEW_SESSION_TRUNCATED',
  'OVERVIEW_REPORT_TRUNCATED',
  'OVERVIEW_OPENING_TRUNCATED',
  'OVERVIEW_STATUS_FAILED',
  'OVERVIEW_STATUS_CANCELLED',
] as const

export type OverviewChromeKey = (typeof OVERVIEW_CHROME_KEYS)[number]

export type OverviewChrome = Record<OverviewChromeKey, string>
