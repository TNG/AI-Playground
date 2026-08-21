import { app } from 'electron'

export const LOG_SOURCE = 'piAgentManager'

const ENV_TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * Verbose Pi turn logging. On in dev (`npm run dev`) so the turn lifecycle and
 * tool traffic flow into the app logger; off in packaged builds unless
 * `AGENT_DEBUG` says otherwise.
 */
export function verboseLogging(): boolean {
  const envFlag = (process.env.AGENT_DEBUG ?? '').toLowerCase()
  return envFlag ? ENV_TRUTHY.has(envFlag) : !app.isPackaged
}

/** Compact one value to a single log-friendly line, truncated. */
export function briefly(value: unknown, max = 300): string {
  let text: string
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value)
  } catch {
    text = String(value)
  }
  if (!text) return ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}… (${oneLine.length} chars)` : oneLine
}
