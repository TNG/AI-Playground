import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import {
  collectOverviewData,
  OVERVIEW_NAMED_RANGES,
  type OverviewRangeInput,
} from '../../session/overviewData.ts'
import { jsonResult, jsonSchemaParameters, textResult } from '../piCustomTools.ts'
import { loadPi } from '../piRuntime.ts'
import type { AgentCapability, CapabilityHost } from './types.ts'
import { OVERVIEW_CAPABILITY_ID } from '@/types/agentCapabilities'

// ── overview capability ──────────────────────────────────────────────────────
//
// The read half of Overviews: one range in, the History of the Sessions the user
// included out. The inclusion switch is the boundary (ADR-0019) — this capability
// cannot widen it, and the reporting Session never appears in its own Overview.
// Writing the report is `overview_write`'s job (a later ticket), so this one
// answers with structured data the Overview Agent turns into prose.

const OVERVIEW_DATA_TOOL = 'overview_data'

const OVERVIEW_DATA_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    range: {
      description:
        'The window to report on: one of the named ranges, or an explicit window. ' +
        '"last-24h" rolls back 24 hours from now; "today" and "yesterday" are local calendar ' +
        'days; "last-7-days" and "last-30-days" start at local midnight. An explicit window ' +
        'takes local dates (YYYY-MM-DD) or ISO timestamps, includes "from" and excludes "to".',
      anyOf: [
        { type: 'string', enum: [...OVERVIEW_NAMED_RANGES] },
        {
          type: 'object',
          additionalProperties: false,
          properties: {
            from: { type: 'string', description: 'Start of the window, inclusive.' },
            to: { type: 'string', description: 'End of the window, exclusive.' },
          },
          required: ['from', 'to'],
        },
      ],
    },
  },
  required: ['range'],
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function rangeOf(value: unknown): OverviewRangeInput | null {
  if (typeof value === 'string') {
    return (OVERVIEW_NAMED_RANGES as readonly string[]).includes(value)
      ? (value as OverviewRangeInput)
      : null
  }
  if (isRecord(value) && typeof value.from === 'string' && typeof value.to === 'string') {
    return { from: value.from, to: value.to }
  }
  return null
}

async function buildOverviewTools(host: CapabilityHost): Promise<ToolDefinition[]> {
  const pi = await loadPi()
  return [
    pi.defineTool({
      name: OVERVIEW_DATA_TOOL,
      label: OVERVIEW_DATA_TOOL,
      description:
        'Read the turns that happened in a time range across the Sessions the user marked ' +
        '"Included in Overviews". Returns the resolved window, each included Session that has ' +
        'turns in it with those turns newest first, per-Session totals and truncation, and the ' +
        'pictures that could represent each Session. Sessions without the switch never appear, ' +
        'and neither does the Session asking. Call it before writing anything, and quote the ' +
        'resolved window and any truncation in your answer.',
      parameters: jsonSchemaParameters(OVERVIEW_DATA_SCHEMA),
      execute: async (_toolCallId, params) => {
        const { range } = params as { range?: unknown }
        const input = rangeOf(range)
        if (!input) {
          return textResult(
            `"range" must be one of ${OVERVIEW_NAMED_RANGES.join(', ')} or an object with ` +
              '"from" and "to" (local dates or ISO timestamps).',
          )
        }
        try {
          const data = await collectOverviewData({
            range: input,
            ...(host.sessionRef ? { excludingSessionId: host.sessionRef } : {}),
          })
          return jsonResult(data)
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error))
        }
      },
    }) as ToolDefinition,
  ]
}

export const overviewCapability: AgentCapability = {
  id: OVERVIEW_CAPABILITY_ID,
  label: 'Overviews',
  summary:
    'Reads the turns and results of the Sessions marked "Included in Overviews" over a time ' +
    'range, so they can be summarised into an Overview. Activate it when the user asks what ' +
    'happened across their Sessions.',
  buildTools: buildOverviewTools,
  // The data call is the first step of the whole task; deferring it would cost a
  // round trip before anything else can happen.
  lazyEligible: false,
}
