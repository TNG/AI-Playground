import { fillTemplate } from '@/lib/fillTemplate'

type Languages = Record<string, string | undefined>

export function agentDisplayName(name: string, languages: Languages): string {
  return name.trim() || (languages.AGENT_LIBRARY_UNNAMED ?? 'Untitled agent')
}

export type NeverRunRefusal = { ok: false; reason: 'never-run'; message: string }

/** A Follow-up refused because the Agent has no run to continue. */
export function neverRunRefusal(name: string, languages: Languages): NeverRunRefusal {
  const template = languages.AGENT_FOLLOW_UP_NEVER_RUN ?? 'Run {agent} first'
  const agent = agentDisplayName(name, languages)
  return { ok: false, reason: 'never-run', message: fillTemplate(template, { agent }) }
}
