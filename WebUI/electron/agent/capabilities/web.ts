import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  interact,
  navigate,
  search,
  type WebBrowserInteraction,
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
export const WEB_INTERACT_TOOL = 'web_interact'

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

const INTERACT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['click', 'type', 'scroll', 'back'],
      description:
        'click: follow link `linkIndex` or click the element at `selector`; type: put `text` ' +
        'into the field at `selector` (set `submit` to press Enter); scroll: scroll down, or to ' +
        '`selector`; back: return to the previous page.',
    },
    linkIndex: { type: 'number', description: 'For click: the [number] of a listed link.' },
    selector: {
      type: 'string',
      description: 'A listed field selector, or any CSS selector, for click / type / scroll.',
    },
    text: { type: 'string', description: 'For type: the text to enter.' },
    submit: { type: 'boolean', description: 'For type: press Enter / submit the form after.' },
  },
  required: ['action'],
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
    `4. ${WEB_INTERACT_TOOL} acts on the page fetched last: {"action":"click","linkIndex":3}`,
    '   follows a link, {"action":"type","selector":"...","text":"...","submit":true} fills a',
    '   listed field. It returns the page as it is afterwards.',
    '5. Answer from what you read, and name the source URLs. If the content is to be kept, write',
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
    lines.push('', `Links (fetch one, or click it by number with ${WEB_INTERACT_TOOL}):`)
    for (const link of page.links.slice(0, MAX_LINKS)) {
      lines.push(`[${link.index}] ${link.text} — ${link.href}`)
    }
  }
  if (page.fields && page.fields.length > 0) {
    lines.push('', `Text fields (type into one with ${WEB_INTERACT_TOOL}):`)
    for (const field of page.fields) lines.push(`- ${field.selector} — ${field.label}`)
  }
  return lines.join('\n')
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
          await failureText(async () => formatSearchResults(await search(query, maxResults))),
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
        return textResult(await failureText(async () => formatPage(await navigate(url))))
      },
    }) as ToolDefinition,
    pi.defineTool({
      name: WEB_INTERACT_TOOL,
      label: WEB_INTERACT_TOOL,
      description:
        `Click, type or scroll on the page ${WEB_FETCH_TOOL} opened last, then return the page as ` +
        'it is afterwards.',
      parameters: jsonSchemaParameters(INTERACT_SCHEMA),
      execute: async (_toolCallId, params) => {
        return textResult(
          await failureText(async () => formatPage(await interact(interactionOf(params)))),
        )
      },
    }) as ToolDefinition,
  ]
}

function interactionOf(params: unknown): WebBrowserInteraction {
  const { action, linkIndex, selector, text, submit } = params as Record<string, unknown>
  const target = typeof selector === 'string' && selector !== '' ? selector : undefined
  switch (action) {
    case 'click':
      return {
        action: 'click',
        ...(typeof linkIndex === 'number' ? { linkIndex } : {}),
        ...(target ? { selector: target } : {}),
      }
    case 'type':
      if (!target) throw new Error('type needs the selector of a field.')
      return {
        action: 'type',
        selector: target,
        text: typeof text === 'string' ? text : '',
        ...(submit === true ? { submit: true } : {}),
      }
    case 'scroll':
      return { action: 'scroll', ...(target ? { selector: target } : {}) }
    case 'back':
      return { action: 'back' }
    default:
      throw new Error(`Unknown action: ${String(action)}`)
  }
}

export const webCapability: AgentCapability = {
  id: 'web',
  label: 'Web access',
  summary:
    'Search the web, read public pages and click or type on them, e.g. to fetch current news ' +
    'or documentation.',
  skills: [WEB_RESEARCH_SKILL],
  buildTools: buildWebTools,
  lazyEligible: true,
}
