import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  navigate,
  search,
  type WebPageSnapshot,
  type WebSearchResults,
} from '../../adapters/webBrowserManager.ts'
import { jsonSchemaParameters, textResult, type SkillSource } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentCapability } from './types.ts'

// ── web capability ───────────────────────────────────────────────────────────
//
// Search and read the public web through the same hidden browser window Chat's
// `searchWeb` / `browseWeb` use (adapters/webBrowserManager.ts). The `browser`
// tool of web-debug can open external pages too, but it is taught as a
// workspace debugger, so models did not reach for it to look something up.

export const WEB_SEARCH_TOOL = 'web_search'
export const WEB_FETCH_TOOL = 'web_fetch'

const MAX_LINKS = 40

const SEARCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    query: { type: 'string', description: 'What to search for.' },
    maxResults: { type: 'number', description: 'How many results to return (default 8).' },
  },
  required: ['query'],
}

const FETCH_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    url: { type: 'string', description: 'Full http(s) URL of the page to read.' },
  },
  required: ['url'],
}

const WEB_RESEARCH_SKILL: SkillSource = {
  name: 'web-research',
  description: 'Look things up on the public web: search, read the pages, cite the sources.',
  body: [
    'Use the web tools whenever the task needs current or external information (news,',
    'documentation, prices, anything after your training data):',
    `1. ${WEB_SEARCH_TOOL} {"query":"..."} — returns titles, URLs and snippets.`,
    `2. ${WEB_FETCH_TOOL} {"url":"https://..."} — returns the readable text of the page and its`,
    '   links. You may fetch a known address directly (e.g. a news front page) without searching.',
    '3. Fetch the most relevant one to three pages; snippets alone are often outdated or cut off.',
    '4. Answer from what you read, and name the source URLs. If the content is to be kept, write',
    '   it into a file in the workspace.',
    'Never invent page content; if a page fails to load, say so and try another source.',
  ].join('\n'),
}

export function formatSearchResults(results: WebSearchResults): string {
  if (results.results.length === 0) {
    return `No results for "${results.query}". Try other words, or fetch a known URL directly.`
  }
  const lines = [`Search results for "${results.query}":`]
  results.results.forEach((result, index) => {
    lines.push(`[${index + 1}] ${result.title} — ${result.url}`)
    if (result.snippet) lines.push(`    ${result.snippet}`)
  })
  return lines.join('\n')
}

export function formatPage(page: WebPageSnapshot): string {
  const lines = [
    `Title: ${page.title || '(untitled)'}`,
    `URL: ${page.url}`,
    '',
    page.text || '(no readable text on this page)',
  ]
  if (page.links.length > 0) {
    lines.push('', `Links (fetch one with ${WEB_FETCH_TOOL}):`)
    for (const link of page.links.slice(0, MAX_LINKS)) lines.push(`- ${link.text} — ${link.href}`)
  }
  return lines.join('\n')
}

// One shared browser window: parallel tool calls must not navigate it under each other.
let queue: Promise<unknown> = Promise.resolve()
function serialized<T>(job: () => Promise<T>): Promise<T> {
  const next = queue.then(job, job)
  queue = next.catch(() => undefined)
  return next
}

async function failureText(job: () => Promise<string>): Promise<string> {
  try {
    return await job()
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function buildWebTools(): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: WEB_SEARCH_TOOL,
      label: WEB_SEARCH_TOOL,
      description: 'Search the public web. Returns result titles, URLs and snippets.',
      parameters: jsonSchemaParameters(SEARCH_SCHEMA),
      execute: async (_toolCallId, params) => {
        const { query, maxResults } = params as { query: string; maxResults?: number }
        return textResult(
          await failureText(async () =>
            formatSearchResults(await serialized(() => search(query, maxResults))),
          ),
        )
      },
    }) as ToolDefinition,
    pi.defineTool({
      name: WEB_FETCH_TOOL,
      label: WEB_FETCH_TOOL,
      description: 'Open a public web page and return its readable text and links.',
      parameters: jsonSchemaParameters(FETCH_SCHEMA),
      execute: async (_toolCallId, params) => {
        const { url } = params as { url: string }
        return textResult(
          await failureText(async () => formatPage(await serialized(() => navigate(url)))),
        )
      },
    }) as ToolDefinition,
  ]
}

export const webCapability: AgentCapability = {
  id: 'web',
  label: 'Web access',
  summary: 'Search the web and read public pages, e.g. to fetch current news or documentation.',
  skills: [WEB_RESEARCH_SKILL],
  buildTools: buildWebTools,
  lazyEligible: true,
}
