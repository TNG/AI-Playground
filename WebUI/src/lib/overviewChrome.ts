import { OVERVIEW_CHROME_KEYS, type OverviewChrome } from '@/types/overviewChrome'

/** The Overview chrome the loader already resolved (en-US merged under the active locale). */
export function overviewChromeOf(locale: string, state: Record<string, string>): OverviewChrome {
  const strings = Object.fromEntries(
    OVERVIEW_CHROME_KEYS.map((key) => [key, state[key] ?? '']),
  ) as OverviewChrome['strings']
  return { locale, strings }
}
