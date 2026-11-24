import { OVERVIEW_CHROME_KEYS, type OverviewChrome } from '@/types/overviewChrome'

/**
 * The Overview chrome resolved from the app's locale files. The loader merges
 * en-US under the active locale, so `state` already holds every key.
 */
export function overviewChromeOf(state: Record<string, string>): OverviewChrome {
  return Object.fromEntries(
    OVERVIEW_CHROME_KEYS.map((key) => [key, state[key] ?? key]),
  ) as OverviewChrome
}
